// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SenseCAP T1000-A/B Tracker (LoRaWAN
// GNSS/Wi-Fi/BLE asset tracker with temperature + light sensors).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/sensecap
// sensecapt1000-tracker-ab-decoder.js, attributed in NOTICE) and the official
// "SenseCAP Tracker T1000-A/B User Guide" section 6.2 "Uplink Packet Parsing".
// The normalization below is authored here; the upstream `messages` array shape
// is NOT reproduced.
//
// Unlike the SenseCAP S210x family (little-endian 7-byte frames + CRC16), the
// T1000 uplink on fPort 5 is a concatenation of variable-length frames, each
// [frameId:1 byte][payload]. The frame length is fixed per frameId. Multi-byte
// fields are BIG-endian. Frames carrying an on-device GNSS fix (0x06, 0x09)
// supply longitude (int32, /1e6) and latitude (int32, /1e6); 0x06/0x07/0x08 add
// air temperature (int16, /10, degC) and light (uint16, percent 0-100). Battery
// is a percentage (uint8) -> `batteryPercent` extra (vocabulary `battery` is
// volts). A uint32 UTC epoch (seconds) becomes the RFC3339 `time`. The decoded
// event-status bit flags are surfaced as the `eventStatus` extra (array of
// names). A sensor field of 0x8000 means "not available" and is omitted.
//
// fPort 5 = measurement frames. fPorts 192/199 (config / positioning-request
// echoes) and any other fPort carry no normalized measurement -> errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Hex string (lowercase) from a byte array, handling negative (signed) ints.
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
  return s;
}

// Big-endian unsigned integer from a hex substring.
function beUnsigned(hex) {
  return parseInt(hex, 16);
}

// Big-endian signed integer (two's complement) from a hex substring; `bits` is
// the field width (16 or 32).
function beSigned(hex, bits) {
  var raw = parseInt(hex, 16);
  var sign = Math.pow(2, bits - 1);
  if (raw >= sign) {
    raw = raw - sign * 2;
  }
  return raw;
}

// The 3-byte event-status field is a bitmask; bit i (LSB first) maps to an event.
function eventNames(hex6) {
  var EVENTS = [
    'startMoving',
    'endMovement',
    'motionless',
    'shock',
    'temperature',
    'light',
    'sos',
    'pressOnce'
  ];
  var mask = parseInt(hex6, 16) & 0xff;
  var names = [];
  for (var i = 0; i < EVENTS.length; i++) {
    if (mask & (1 << i)) {
      names.push(EVENTS[i]);
    }
  }
  return names;
}

// Frame length in hex characters keyed by frameId (incl. the 1-byte id), per
// the upstream `unpack` packageLen table. Only the frame types this codec
// normalizes (the GNSS-fix packets 0x06 and 0x09) are decoded; lengths for the
// other known frame types are listed so a packet that concatenates them can be
// advanced past rather than mis-parsed.
function frameHexLen(id) {
  if (id === 0x01) { return 94; }
  if (id === 0x02) { return 32; }
  if (id === 0x03) { return 64; }
  if (id === 0x04) { return 20; }
  if (id === 0x05) { return 10; }
  if (id === 0x06) { return 44; }
  if (id === 0x07) { return 84; }
  if (id === 0x08) { return 70; }
  if (id === 0x09) { return 36; }
  if (id === 0x0a) { return 76; }
  if (id === 0x0b) { return 62; }
  if (id === 0x0d) { return 10; }
  if (id === 0x0f) { return 34; }
  if (id === 0x10) { return 26; }
  if (id === 0x11) { return 28; }
  return 0; // unknown / variable-length (0x0e) / unsupported -> stop parsing
}

function decodeUplink(input) {
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
  var air = {};
  var position = {};
  var hasAir = false;
  var hasPosition = false;
  var hasMeasurement = false;

  var i = 0;
  var guard = 0;
  while (i + 2 <= hex.length && guard < 64) {
    guard++;
    var id = parseInt(hex.substring(i, i + 2), 16);
    var len = frameHexLen(id);
    if (len === 0 || i + len > hex.length) {
      // Unsupported or truncated frame -> stop parsing further frames.
      break;
    }
    var body = hex.substring(i + 2, i + len);
    i += len;

    // Only the GNSS-fix packets carry an on-device latitude/longitude. The
    // Wi-Fi (0x07/0x0a) and BLE (0x08/0x0b) packets carry MAC scans for
    // cloud-side resolution, not a position, and are intentionally not
    // normalized; config/info/error frames carry no measurement.
    if (id === 0x06 || id === 0x09) {
      // Layout: event status (3) + motion (1) + UTC (4) + lon (4) + lat (4).
      var events = eventNames(body.substring(0, 6));
      var ts = beUnsigned(body.substring(8, 16));
      data.time = new Date(ts * 1000).toISOString();
      if (events.length > 0) {
        data.eventStatus = events;
      }

      // GNSS fix: longitude then latitude as int32 /1e6.
      var lon = beSigned(body.substring(16, 24), 32) / 1000000;
      var lat = beSigned(body.substring(24, 32), 32) / 1000000;
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        position.longitude = round(lon, 6);
        position.latitude = round(lat, 6);
        hasPosition = true;
        hasMeasurement = true;
      }

      if (id === 0x06) {
        var tHex = body.substring(32, 36);
        if (tHex.toLowerCase() !== '8000') {
          air.temperature = round(beSigned(tHex, 16) / 10, 1);
          hasAir = true;
          hasMeasurement = true;
        }
        var lHex = body.substring(36, 40);
        if (lHex.toLowerCase() !== '8000') {
          air.lightIntensity = beUnsigned(lHex);
          hasAir = true;
          hasMeasurement = true;
        }
        data.batteryPercent = beUnsigned(body.substring(40, 42));
        hasMeasurement = true;
      } else {
        data.batteryPercent = beUnsigned(body.substring(32, 34));
        hasMeasurement = true;
      }
    }
  }

  if (!hasMeasurement) {
    return { errors: ['no decodable measurement frame in payload'] };
  }

  if (hasPosition) {
    data.position = position;
  }
  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
