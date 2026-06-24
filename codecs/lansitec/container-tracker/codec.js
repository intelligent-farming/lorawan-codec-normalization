// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Lansitec Container Tracker (LoRaWAN asset
// tracker: on-device GNSS position fix, BLE positioning/asset beacons, battery
// voltage, device temperature, link quality, and motion/alarm state).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/lansitec/container-tracker.js,
// attributed in NOTICE). The upstream field extraction is reproduced faithfully;
// only the JSON shape is re-authored to the normalized vocabulary (never the
// upstream per-message Object output). GPS mapping follows the convention used by
// codecs/digital-matter/oyster (signed decimal-degree lat/lon, range-guarded,
// rounded to GPS resolution).
//
// The tracker multiplexes message types onto the high nibble of byte 0:
//   0x1 Register              — configuration report (no fix)
//   0x2 Heartbeat             — battery, link quality, temperature, motion state
//   0x3 GNSS Position         — live on-device GNSS fix (lat/lon float32 BE)
//   0x7 Position Beacon       — BLE beacons heard (cloud-solved scan)
//   0x8 Asset Beacon          — BLE asset beacons heard (cloud-solved scan)
//   0x9 Alarm                 — magnet/tamper alarm
//   0xA Shock Detection       — shock event counter
//   0xB Offline Cache Position— cached BLE/GNSS positions (history)
//
// Only the GNSS Position message yields an on-device position.* fix. BLE scans
// are positioning *inputs* that require a cloud solver, so they are surfaced as
// camelCase extras (bleBeacons), never as position.*.
//
// Deliberate fork from upstream: upstream builds its fix timestamp as
//   new Date((unixSeconds + 8*3600) * 1000)
// which shifts the actual instant forward by 8 hours (a CST offset mistakenly
// applied to an already-UTC epoch). We decode the true UTC instant.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u32be(bytes, off) {
  return ((bytes[off] << 24) >>> 0) +
    (bytes[off + 1] << 16) +
    (bytes[off + 2] << 8) +
    bytes[off + 3];
}

// Interpret a big-endian 32-bit word as an IEEE-754 single-precision float.
function f32be(bytes, off) {
  var word = u32be(bytes, off);
  var sign = (word & 0x80000000) ? -1 : 1;
  var exponent = (word >> 23) & 0xff;
  var mantissa = word & 0x7fffff;
  if (exponent === 0 && mantissa === 0) {
    return 0;
  }
  if (exponent === 0xff) {
    // Inf / NaN — treat as invalid; callers range-guard the result.
    return mantissa ? NaN : sign * Infinity;
  }
  if (exponent === 0) {
    return sign * mantissa * Math.pow(2, -149);
  }
  return sign * (1 + mantissa / 0x800000) * Math.pow(2, exponent - 127);
}

function hex2(v) {
  var s = (v & 0xff).toString(16).toUpperCase();
  return s.length < 2 ? '0' + s : s;
}

function decodeGnssPosition(bytes) {
  if (bytes.length < 13) {
    return { errors: ['GNSS position message requires 13 bytes'] };
  }

  var lon = round(f32be(bytes, 1), 7);
  var lat = round(f32be(bytes, 5), 7);
  var unixSeconds = u32be(bytes, 9);

  var data = { messageType: 'gnssPosition' };
  var warnings = [];

  var position = {};
  if (lat >= -90 && lat <= 90) {
    position.latitude = lat;
  }
  if (lon >= -180 && lon <= 180) {
    position.longitude = lon;
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  } else {
    warnings.push('GNSS coordinates out of range');
  }

  if (unixSeconds > 0) {
    data.time = new Date(unixSeconds * 1000).toISOString();
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function decodeHeartbeat(bytes) {
  if (bytes.length < 10) {
    return { errors: ['heartbeat message requires 10 bytes'] };
  }

  var gpsStates = {
    0: 'off',
    1: 'bootGps',
    2: 'locating',
    3: 'located',
    9: 'noSignal'
  };

  var vibrationLevel = bytes[5] & 0x0f;
  var snrIncluded = (bytes[0] & 0x0f) === 0x01;
  var gpsStateCode = (bytes[5] >> 4) & 0x0f;

  var data = {
    messageType: 'heartbeat',
    battery: round(bytes[1] * 0.01 + 1.5, 2),
    rssi: -bytes[2],
    gpsState: gpsStates[gpsStateCode] !== undefined ? gpsStates[gpsStateCode] : 'unknown',
    vibrationLevel: vibrationLevel,
    temperatureC: ((bytes[6] << 8) | bytes[7]),
    movementSeconds: ((bytes[8] << 8) | bytes[9]) * 5,
    action: { motion: { detected: vibrationLevel > 0 } }
  };

  if (snrIncluded) {
    data.snr = round((((bytes[3] << 8) | bytes[4]) * 0.01), 2);
  }

  return { data: data };
}

function decodeBleBeacons(bytes, messageType, offset, count) {
  var beacons = [];
  for (var i = 0; i < count; i++) {
    var base = offset + 5 * i;
    if (base + 4 >= bytes.length) {
      break;
    }
    beacons.push({
      major: hex2(bytes[base]) + hex2(bytes[base + 1]),
      minor: hex2(bytes[base + 2]) + hex2(bytes[base + 3]),
      rssi: bytes[base + 4] - 256
    });
  }
  return {
    data: {
      messageType: messageType,
      bleBeacons: beacons
    }
  };
}

function decodePositionBeacon(bytes) {
  if (bytes.length < 2) {
    return { errors: ['position beacon message requires at least 2 bytes'] };
  }
  var count = bytes[0] & 0x0f;
  // BLE positioning beacons start at byte 6 (bytes 2-5 are reserved).
  return decodeBleBeacons(bytes, 'positionBeacon', 6, count);
}

function decodeAssetBeacon(bytes) {
  if (bytes.length < 2) {
    return { errors: ['asset beacon message requires at least 2 bytes'] };
  }
  var count = bytes[1];
  return decodeBleBeacons(bytes, 'assetBeacon', 2, count);
}

function decodeAlarm(bytes) {
  if (bytes.length < 2) {
    return { errors: ['alarm message requires at least 2 bytes'] };
  }
  return {
    data: {
      messageType: 'alarm',
      alarm: (bytes[1] & 0x01) === 0x01 ? 'magnetRemoved' : 'cleared'
    }
  };
}

function decodeShock(bytes) {
  if (bytes.length < 3) {
    return { errors: ['shock detection message requires 3 bytes'] };
  }
  return {
    data: {
      messageType: 'shockDetection',
      shockCount: ((bytes[1] << 8) | bytes[2])
    }
  };
}

function decodeRegister(bytes) {
  return {
    data: {
      messageType: 'register'
    }
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }

  var messageType = (bytes[0] >> 4) & 0x0f;

  if (messageType === 0x1) {
    return decodeRegister(bytes);
  }
  if (messageType === 0x2) {
    return decodeHeartbeat(bytes);
  }
  if (messageType === 0x3) {
    return decodeGnssPosition(bytes);
  }
  if (messageType === 0x7) {
    return decodePositionBeacon(bytes);
  }
  if (messageType === 0x8) {
    return decodeAssetBeacon(bytes);
  }
  if (messageType === 0x9) {
    return decodeAlarm(bytes);
  }
  if (messageType === 0xa) {
    return decodeShock(bytes);
  }
  if (messageType === 0xb) {
    // Offline cache positions are historical cached BLE/GNSS scans; surface as
    // an extra rather than a live position fix.
    return { data: { messageType: 'offlineCachePosition' } };
  }

  return { errors: ['unsupported message type'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "lansitec";
    result.data.model = "container-tracker";
  }
  return result;
}
