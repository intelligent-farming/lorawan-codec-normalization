// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Abeeway Industrial Tracker (ruggedized
// IP65 multi-mode geolocation asset tracker: GPS/Low-power GPS + WiFi sniffer +
// BLE + LoRaWAN TDoA + accelerometer + temperature, on the Abeeway "Asset
// Tracker 2.0" uplink format, fPort 18).
//
// The wire format (a message-type-framed payload: byte[0] selects the message
// type, byte[1] packs tracking-mode / motion / position flags, byte[2] is the
// battery level, byte[3] is temperature, byte[4] packs ack-token + raw position
// type, then a per-message body) was ported from and decoded against the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/abeeway/asset-tracker-2.js, attributed in NOTICE). The Industrial
// Tracker shares the Asset Tracker 2.0 firmware/uplink protocol with the
// Abeeway Compact Tracker sibling; the upstream field extraction (byte slicing,
// the `decodeCondensed` companding, the 3-byte + "00" shift lat/lon assembly)
// is reproduced faithfully; only the JSON shape is re-authored to the
// normalized vocabulary (never the upstream normalizeUplink/normalizedOutput).
//
// Normalization decisions:
//   - A GPS/GNSS fix (POSITION_MESSAGE with rawPositionType GPS) genuinely
//     decodes a latitude/longitude ON-DEVICE -> position.latitude /
//     position.longitude. WiFi-BSSID and BLE-beacon scan frames carry MAC lists
//     for CLOUD solving, not a decoded position, so they emit only the
//     scan MAC lists as camelCase extras (no position.*).
//   - Air temperature -> air.temperature (°C).
//   - The "moving" flag (DynamicMotionState MOVING/STATIC) -> action.motion.detected.
//   - On fPort 18 the device reports a battery LEVEL (0-255 fuel-gauge units,
//     0 = charging / 255 = unknown sentinel), NOT a voltage, so it is emitted as
//     the camelCase extra `batteryLevel` (the vocabulary `battery` is volts and
//     `batteryPercent` is a true 0-100 percentage; neither matches this scale).
//   - Message type, raw position type, tracking mode, fix age, horizontal
//     accuracy, scan MAC lists, and status flags -> camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function byteToHex(b) {
  var hex = (b & 0xff).toString(16);
  if (hex.length < 2) {
    hex = '0' + hex;
  }
  return hex;
}

function bytesToHex(bytes, start, end) {
  var s = '';
  for (var i = start; i < end; i++) {
    s += byteToHex(bytes[i]);
  }
  return s;
}

// Upstream companding: maps a single byte back onto the [lo, hi] range with
// `nresv` reserved codes. Verbatim from the upstream decodeCondensed().
function decodeCondensed(value, lo, hi, nbits, nresv) {
  return (value - nresv / 2) / ((((1 << nbits) - 1) - nresv) / (hi - lo)) + lo;
}

var MSG_FRAME_PENDING = 0;
var MSG_POSITION = 3;
var MSG_EVENT = 10;

// rawPositionType (byte[4] & 0x0F) values that carry a decoded GPS lat/lon.
var RAW_POS_GPS = 0;

var TRACKING_MODES = [
  'STAND_BY',
  'MOTION_TRACKING',
  'PERMANENT_TRACKING',
  'MOTION_START_END_TRACKING',
  'ACTIVITY_TRACKING',
  'OFF'
];

var RAW_POSITION_TYPES = [
  'GPS',
  'GPS_TIMEOUT',
  'ENCRYPTED_WIFI_BSSIDS',
  'WIFI_TIMEOUT',
  'WIFI_FAILURE',
  'XGPS_DATA',
  'XGPS_DATA_WITH_GPS_SW_TIME',
  'BLE_BEACON_SCAN',
  'BLE_BEACON_FAILURE',
  'WIFI_BSSIDS_WITH_NO_CYPHER',
  'BLE_BEACON_SCAN_SHORT_ID',
  'BLE_BEACON_SCAN_LONG_ID'
];

function trackingModeName(payload) {
  var idx = (payload[1] >> 5) & 0x07;
  return TRACKING_MODES[idx];
}

// "moving" flag: bit 2 of byte[1]. 0 = STATIC, 1 = MOVING.
function isMoving(payload) {
  return ((payload[1] >> 2) & 0x01) === 1;
}

function batteryLevel(payload) {
  var v = payload[2];
  if (v === 0 || v === 255) {
    return null;
  }
  return v;
}

function temperature(payload) {
  return round(decodeCondensed(payload[3], -44, 85, 8, 0), 1);
}

function rawPositionTypeName(payload) {
  var v = payload[4] & 0x0f;
  if (v < RAW_POSITION_TYPES.length) {
    return RAW_POSITION_TYPES[v];
  }
  return 'UNKNOWN';
}

// Lat/lon: 3 high bytes + a "00" low-byte shift, parsed as a signed 32-bit
// integer of 1e-7 degrees (verbatim from upstream determineLatitude/Longitude
// for POSITION_MESSAGE: payload.slice(6,9)/slice(9,12) + "00").
function decodeCoord(bytes, start) {
  var coded = parseInt(bytesToHex(bytes, start, start + 3) + '00', 16);
  if (coded > 0x7fffffff) {
    coded -= 0x100000000;
  }
  return coded / 10000000;
}

// WiFi BSSID / BLE beacon MAC list: 6-byte MAC + 1 signed RSSI byte per entry,
// starting at byte index 6 for POSITION_MESSAGE (verbatim from upstream
// determineBSSIDS). Returned as camelCase extras for cloud-side solving.
function decodeMacScan(payload, separator) {
  var entries = [];
  var i = 0;
  while (payload.length >= 13 + 7 * i) {
    var base = 6 + i * 7;
    var mac =
      byteToHex(payload[base]) + separator +
      byteToHex(payload[base + 1]) + separator +
      byteToHex(payload[base + 2]) + separator +
      byteToHex(payload[base + 3]) + separator +
      byteToHex(payload[base + 4]) + separator +
      byteToHex(payload[base + 5]);
    var rssi = payload[base + 6];
    if (rssi > 127) {
      rssi -= 256;
    }
    entries.push({ id: mac, rssi: rssi });
    i++;
  }
  return entries;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['payload too short for an Abeeway uplink'] };
  }

  var messageType = bytes[0];

  // FRAME_PENDING carries no measurement, only a downlink-pending indicator.
  if (messageType === MSG_FRAME_PENDING) {
    return { errors: ['frame-pending uplink carries no normalized measurement'] };
  }

  if (bytes.length < 4) {
    return { errors: ['payload too short for an Abeeway status header'] };
  }

  var data = {};

  // Common header (present for every non-frame-pending, non-SMS message).
  data.trackingMode = trackingModeName(bytes);

  var moving = isMoving(bytes);
  data.action = { motion: { detected: moving } };

  var temp = temperature(bytes);
  data.air = { temperature: temp };

  var level = batteryLevel(bytes);
  if (level !== null) {
    data.batteryLevel = level;
  }

  if (messageType === MSG_POSITION) {
    var rawType = rawPositionTypeName(bytes);
    data.messageType = 'POSITION_MESSAGE';
    data.rawPositionType = rawType;

    if ((bytes[4] & 0x0f) === RAW_POS_GPS) {
      if (bytes.length < 12) {
        return { errors: ['payload too short for a GPS position fix'] };
      }
      var lat = decodeCoord(bytes, 6);
      var lon = decodeCoord(bytes, 9);
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return { errors: ['decoded GPS position out of range'] };
      }
      data.position = { latitude: round(lat, 7), longitude: round(lon, 7) };

      // Fix age (companded seconds) and horizontal accuracy (companded metres).
      data.fixAge = Math.round(decodeCondensed(bytes[5], 0, 2040, 8, 0));
      if (bytes.length >= 13) {
        data.horizontalAccuracy = round(decodeCondensed(bytes[12], 0, 1000, 8, 0), 2);
      }
    } else if (
      rawType === 'WIFI_BSSIDS_WITH_NO_CYPHER' &&
      bytes.length >= 13
    ) {
      // WiFi scan: MAC list for cloud solving, not an on-device position.
      data.fixAge = Math.round(decodeCondensed(bytes[5], 0, 2040, 8, 0));
      data.wifiBssids = decodeMacScan(bytes, ':');
    } else if (rawType === 'BLE_BEACON_SCAN' && bytes.length >= 13) {
      // BLE beacon scan: MAC list for cloud solving, not an on-device position.
      data.fixAge = Math.round(decodeCondensed(bytes[5], 0, 2040, 8, 0));
      data.bleBssids = decodeMacScan(bytes, ':');
    }
    // Other rawPositionType frames (timeouts, failures, encrypted/short/long
    // beacon variants) carry no decoded position; the climate + motion fields
    // already emitted above stand on their own.

    return { data: data };
  }

  if (messageType === MSG_EVENT) {
    data.messageType = 'EVENT';
    return { data: data };
  }

  // Other message types (heartbeat, energy/health status, activity, shock,
  // configuration, BLE-MAC, debug) still carry the climate + motion header.
  data.messageType = 'OTHER';
  data.messageTypeCode = messageType;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "abeeway";
    result.data.model = "abeeway-industrial-tracker";
  }
  return result;
}
