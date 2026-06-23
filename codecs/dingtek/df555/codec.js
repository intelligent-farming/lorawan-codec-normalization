// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF555 (LoRaWAN ultrasonic tank-level
// sensor with an optional on-board GNSS module: tank fill level, a GPS position
// fix, surface temperature, level/battery alarm flags and a frame counter).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df555.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets; IEEE-754 lat/lon)
// is reproduced faithfully; only the JSON shape is re-authored to the
// normalized vocabulary (never the upstream object output).
//
// All uplinks arrive on FPort 3. Frame type is keyed by payload length:
//   17 bytes, byte[3] != 0x03  Heartbeat (no fix): level, temperature, alarms.
//   17 bytes, byte[3] == 0x03  Parameter packet: firmware / intervals / mode.
//   25 bytes                   Heartbeat WITH a live GNSS fix: as above plus
//                              IEEE-754 little-endian longitude/latitude.
//
// GPS frame (25 bytes):
//   latitude/longitude are signed decimal degrees (WGS84), decoded from two
//   little-endian IEEE-754 single-precision floats and rounded to 6 dp (the
//   ~0.1 m device resolution). Upstream emits them as toFixed(6) strings; we
//   publish numeric position.latitude / position.longitude per the vocabulary.
//   Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed to guard
//   against a malformed frame over-reading the packed fields.
//
//   temperature byte -> air.temperature (degC).
//   level / alarmLevel / alarmBattery / frameCounter -> camelCase extras
//   (tank fill level has no vocabulary key).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// IEEE-754 single-precision (32-bit) integer -> float.
function hex2float(num) {
  var sign = num & 0x80000000 ? -1 : 1;
  var exponent = ((num >> 23) & 0xff) - 127;
  var mantissa = 1 + (num & 0x7fffff) / 0x7fffff;
  return sign * mantissa * Math.pow(2, exponent);
}

function decodeHeartbeat(bytes) {
  return {
    data: {
      level: (bytes[5] << 8) + bytes[6],
      air: { temperature: bytes[8] },
      frameCounter: (bytes[13] << 8) + bytes[14],
      alarmLevel: Boolean(bytes[11] >> 4),
      alarmBattery: Boolean(bytes[12] & 0x0f)
    }
  };
}

function decodeParameters(bytes) {
  return {
    data: {
      firmware: bytes[5] + '.' + bytes[6],
      uploadInterval: bytes[7],
      detectInterval: bytes[8],
      levelThreshold: bytes[9],
      workMode: bytes[14]
    }
  };
}

function decodeGps(bytes) {
  var lonRaw = hex2float((bytes[11] << 24) + (bytes[10] << 16) + (bytes[9] << 8) + bytes[8]);
  var latRaw = hex2float((bytes[15] << 24) + (bytes[14] << 16) + (bytes[13] << 8) + bytes[12]);
  var lon = round(lonRaw, 6);
  var lat = round(latRaw, 6);

  var data = {
    level: (bytes[5] << 8) + bytes[6],
    air: { temperature: bytes[16] },
    frameCounter: (bytes[21] << 8) + bytes[22],
    alarmLevel: Boolean(bytes[19] >> 4),
    alarmBattery: Boolean(bytes[20] & 0x0f)
  };

  var position = {};
  if (lat >= -90 && lat <= 90) {
    position.latitude = lat;
  }
  if (lon >= -180 && lon <= 180) {
    position.longitude = lon;
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }

  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (bytes.length === 17) {
    if (bytes[3] === 0x03) {
      return decodeParameters(bytes);
    }
    return decodeHeartbeat(bytes);
  }
  if (bytes.length === 25) {
    return decodeGps(bytes);
  }

  return { errors: ['wrong length (expected 17 or 25 bytes)'] };
}
