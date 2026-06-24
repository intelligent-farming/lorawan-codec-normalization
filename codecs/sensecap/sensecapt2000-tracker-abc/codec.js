// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SenseCAP T2000-A/B/C Tracker (LoRaWAN
// GNSS/Wi-Fi/BLE asset tracker with an accelerometer).
//
// Ported and normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/sensecap
// sensecapt2000-tracker-abc-decoder.js, attributed in NOTICE). The wire-format
// parsing below is a faithful port of upstream `unpack`/`deserialize`; the
// upstream `{valid,err,payload,messages}` envelope is NOT reproduced — we author
// a single normalized measurement object.
//
// Wire format: the T2000 uplink is an UPPERCASE-hex concatenation of frames,
// each [dataId:1 byte][payload]. Most frame types have a fixed length; the scan
// frames (0x2C/0x2D/0x2F/0x30) are dynamic, sized by an embedded scan count.
// Multi-byte numeric fields are BIG-endian; signed fields are two's complement.
// A sensor field of 0x8000 means "not available" and is omitted.
//
// On-device decoded data and their normalized mapping:
//   - GNSS fix (frames 0x2B, 0x2E): longitude/latitude int32 /1e6 ->
//     position.longitude / position.latitude.
//   - Movement events (event-status bitmask, all location/scan frames): a
//     "start moving" or "shock" event -> action.motion.detected = true; an "end
//     movement" or "motionless" event -> action.motion.detected = false.
//   - Battery is a PERCENTAGE byte -> the camelCase extra `batteryPercent`
//     (vocabulary `battery` is volts, not percent).
//   - Accelerometer X/Y/Z (int16) -> extras accelerometerX/Y/Z.
//   - Wi-Fi / BLE MAC scans -> extras wifiScan / bleScan (arrays of {mac,rssi})
//     for cloud-side resolution; they are not an on-device position.
//   - UTC epoch seconds -> RFC3339 `time`. All decoded event names -> the
//     `eventStatus` extra (array). motionId -> the `motionId` extra.
//
// The T2000 does NOT decode any numeric air temperature, humidity, or light
// value on-device (temperature/light appear only as event FLAGS), so no
// air.* keys are emitted and the climate/light categories do not apply.
//
// fPort 5 carries measurement frames. Other fPorts / empty payloads / packets
// with no decodable measurement frame -> errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Uppercase hex string from a byte array (handles signed ints).
function bytesToHex(arr) {
  var s = '';
  for (var i = 0; i < arr.length; i++) {
    var n = arr[i] & 0xff;
    var t = n.toString(16);
    if (t.length === 1) {
      t = '0' + t;
    }
    s += t;
  }
  return s.toUpperCase();
}

// Big-endian unsigned integer from a hex substring.
function beUnsigned(hex) {
  return parseInt(hex, 16);
}

// Big-endian signed integer (two's complement) from a hex substring; `bits` is
// the field width (8, 16 or 32).
function beSigned(hex, bits) {
  var raw = parseInt(hex, 16);
  var sign = Math.pow(2, bits - 1);
  if (raw >= sign) {
    raw = raw - sign * 2;
  }
  return raw;
}

// Frame length in hex characters (incl. the 1-byte id) for fixed-length frames,
// per the upstream FIXED_LENGTH_PACKAGES table.
function fixedHexLen(id) {
  if (id === '27') { return 92; }
  if (id === '28') { return 60; }
  if (id === '29') { return 24; }
  if (id === '2A') { return 12; }
  if (id === '2B') { return 46; }
  if (id === '2E') { return 34; }
  if (id === '31') { return 30; }
  if (id === '32') { return 18; }
  if (id === '0D') { return 10; }
  return 0;
}

// Dynamic scan-frame geometry, per the upstream DYNAMIC_LENGTH_PACKAGES table.
// scanCountPos is the character offset of the scan-count byte into the FULL
// frame (including the 1-byte id).
function dynamicCfg(id) {
  if (id === '2C' || id === '2D') {
    return { minLen: 32, scanCountPos: 30, baseLen: 23, itemLen: 7 };
  }
  if (id === '2F' || id === '30') {
    return { minLen: 20, scanCountPos: 18, baseLen: 17, itemLen: 7 };
  }
  return null;
}

// Event-status bitmask -> array of camelCase event names. Mirrors upstream
// getEventStatus: per-byte 8-bit binary (big-endian byte order), concatenated,
// then the whole bit string reversed; bit index i maps to EVENTS[i].
function eventNames(hex) {
  var EVENTS = [
    'startMoving',     // id 1
    'endMovement',     // id 2
    'motionless',      // id 3
    'shock',           // id 4
    'temperature',     // id 5
    'light',           // id 6
    'sos',             // id 7
    'pressOnce',       // id 8
    'disassembled'     // id 9
  ];
  var bits = '';
  for (var b = 0; b < hex.length; b += 2) {
    var byteBin = parseInt(hex.substring(b, b + 2), 16).toString(2);
    while (byteBin.length < 8) {
      byteBin = '0' + byteBin;
    }
    bits += byteBin;
  }
  var rev = '';
  for (var r = bits.length - 1; r >= 0; r--) {
    rev += bits.substring(r, r + 1);
  }
  var names = [];
  for (var i = 0; i < EVENTS.length; i++) {
    if (rev.substring(i, i + 1) === '1') {
      names.push(EVENTS[i]);
    }
  }
  return names;
}

// Reconstruct a colon-separated MAC; upstream treats all-FF as "no MAC".
function macAddress(hex12) {
  if (hex12.toLowerCase() === 'ffffffffffff') {
    return null;
  }
  var mac = '';
  for (var i = 0; i < 12; i += 2) {
    mac += hex12.substring(i, i + 2);
    if (i < 10) {
      mac += ':';
    }
  }
  return mac;
}

// Parse a concatenation of [mac:6][rssi:1] entries into {mac,rssi} objects.
function macRssiList(hex) {
  var pairs = [];
  if (hex.length % 14 !== 0) {
    return pairs;
  }
  for (var i = 0; i < hex.length; i += 14) {
    var mac = macAddress(hex.substring(i, i + 12));
    if (mac) {
      pairs.push({ mac: mac, rssi: beSigned(hex.substring(i + 12, i + 14), 8) });
    }
  }
  return pairs;
}

// Apply a movement event to action.motion.detected. start/shock => moving;
// end/motionless => still (only if not already set true in this packet).
function motionFromEvents(events, current) {
  var detected = current;
  for (var i = 0; i < events.length; i++) {
    if (events[i] === 'startMoving' || events[i] === 'shock') {
      detected = true;
    } else if (events[i] === 'endMovement' || events[i] === 'motionless') {
      if (detected !== true) {
        detected = false;
      }
    }
  }
  return detected;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  if (fPort !== 5) {
    return { errors: ['unsupported fPort ' + fPort + ' (only fPort 5 carries measurement frames)'] };
  }

  var hex = bytesToHex(bytes);

  var data = {};
  var position = {};
  var hasPosition = false;
  var motionDetected = null;
  var hasMeasurement = false;
  var lastTime = null;
  var allEvents = [];
  var accel = null;
  var wifiScan = null;
  var bleScan = null;
  var battPercent = null;
  var motionIdVal = null;

  var i = 0;
  var guard = 0;
  while (i + 2 <= hex.length && guard < 64) {
    guard++;
    var id = hex.substring(i, i + 2);

    var frameLen;
    var cfg = dynamicCfg(id);
    if (cfg) {
      if (hex.length - i < cfg.minLen) {
        break;
      }
      var scanCount = parseInt(hex.substring(i + cfg.scanCountPos, i + cfg.scanCountPos + 2), 16);
      frameLen = (cfg.baseLen + (scanCount - 1) * cfg.itemLen) * 2;
    } else {
      frameLen = fixedHexLen(id);
    }

    if (frameLen === 0 || i + frameLen > hex.length) {
      // Unsupported / truncated frame -> stop parsing further frames.
      break;
    }

    // body = chars after the 1-byte id (matches upstream `dataValue`).
    var body = hex.substring(i + 2, i + frameLen);
    i += frameLen;

    if (id === '2B' || id === '2E') {
      // Layout: event(0,4) motionId(4,6) UTC(6,14) then frame-specific.
      var events = eventNames(body.substring(0, 4));
      motionIdVal = beUnsigned(body.substring(4, 6));
      var ts = beUnsigned(body.substring(6, 14));
      lastTime = new Date(ts * 1000).toISOString();
      for (var e = 0; e < events.length; e++) {
        allEvents.push(events[e]);
      }
      motionDetected = motionFromEvents(events, motionDetected);

      var locStart;
      var battPos;
      if (id === '2B') {
        // accel(14,26) location(26,42) battery(42,44)
        accel = {
          x: beSigned(body.substring(14, 18), 16),
          y: beSigned(body.substring(18, 22), 16),
          z: beSigned(body.substring(22, 26), 16)
        };
        locStart = 26;
        battPos = 42;
      } else {
        // 2E: location(14,30) battery(30,32)
        locStart = 14;
        battPos = 30;
      }

      var lon = beSigned(body.substring(locStart, locStart + 8), 32) / 1000000;
      var lat = beSigned(body.substring(locStart + 8, locStart + 16), 32) / 1000000;
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        position.longitude = round(lon, 6);
        position.latitude = round(lat, 6);
        hasPosition = true;
      }
      battPercent = beUnsigned(body.substring(battPos, battPos + 2));
      hasMeasurement = true;
    } else if (id === '2C' || id === '2D' || id === '2F' || id === '30') {
      // Scan frames carry MAC scans + accel/battery/events but no on-device fix.
      var sEvents = eventNames(body.substring(0, 4));
      motionIdVal = beUnsigned(body.substring(4, 6));
      var sts = beUnsigned(body.substring(6, 14));
      lastTime = new Date(sts * 1000).toISOString();
      for (var se = 0; se < sEvents.length; se++) {
        allEvents.push(sEvents[se]);
      }
      motionDetected = motionFromEvents(sEvents, motionDetected);

      var scanStart;
      if (id === '2C' || id === '2D') {
        // accel(14,26) battery(26,28) scanMax(28,30) scan(30..)
        accel = {
          x: beSigned(body.substring(14, 18), 16),
          y: beSigned(body.substring(18, 22), 16),
          z: beSigned(body.substring(22, 26), 16)
        };
        battPercent = beUnsigned(body.substring(26, 28));
        scanStart = 30;
      } else {
        // 2F/30: battery(14,16) scanMax(16,18) scan(18..)
        battPercent = beUnsigned(body.substring(14, 16));
        scanStart = 18;
      }
      var list = macRssiList(body.substring(scanStart));
      if (id === '2C' || id === '2F') {
        wifiScan = list;
      } else {
        bleScan = list;
      }
      hasMeasurement = true;
    } else if (id === '2A') {
      // Status/heartbeat: battery + config. Surface battery only.
      battPercent = beUnsigned(body.substring(0, 2));
      hasMeasurement = true;
    } else if (id === '27') {
      // Device info / boot: battery is the first byte. No position.
      battPercent = beUnsigned(body.substring(0, 2));
      hasMeasurement = true;
    } else if (id === '0D') {
      // GNSS positioning error report.
      var code = beUnsigned(body.substring(0, 8));
      return { errors: ['device reported positioning error code ' + code] };
    }
    // Other frame types (config 0x28/0x29, positioning-status 0x31/0x32, time
    // sync) carry no normalized measurement and are advanced past.
  }

  if (!hasMeasurement) {
    return { errors: ['no decodable measurement frame in payload'] };
  }

  if (lastTime !== null) {
    data.time = lastTime;
  }
  if (hasPosition) {
    data.position = position;
  }
  if (motionDetected !== null) {
    data.action = { motion: { detected: motionDetected } };
  }
  if (battPercent !== null) {
    data.batteryPercent = battPercent;
  }
  if (motionIdVal !== null) {
    data.motionId = motionIdVal;
  }
  if (accel !== null) {
    data.accelerometerX = accel.x;
    data.accelerometerY = accel.y;
    data.accelerometerZ = accel.z;
  }
  if (wifiScan !== null) {
    data.wifiScan = wifiScan;
  }
  if (bleScan !== null) {
    data.bleScan = bleScan;
  }
  if (allEvents.length > 0) {
    data.eventStatus = allEvents;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sensecap";
    result.data.model = "sensecapt2000-tracker-abc";
  }
  return result;
}
