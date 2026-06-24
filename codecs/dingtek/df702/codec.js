// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF702 (ultrasonic waste-bin fill-level
// sensor with an optional built-in GPS module: fill distance in mm, bin
// temperature, tilt angle, full / fire / tilt / low-battery status flags, and —
// on the longer data frame — a live on-device GNSS latitude/longitude fix).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df702.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets; lat/lon as 4-byte
// little-endian IEEE754 floats) is reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Frames all arrive on FPort 3. The payload length selects the layout:
//   17 bytes  data frame, no GPS
//   25 bytes  data frame with GPS (bytes[3] != 0x03), OR a parameter/config
//             confirmation frame (bytes[3] == 0x03) which carries device
//             settings, not a measurement, and is reported as an error.
//
// Field mapping:
//   level (mm, big-endian)       -> fillDistanceMm (extra; distance to contents)
//   temperature (°C)             -> air.temperature
//   tilt angle (°, signed)       -> tiltAngle (extra)
//   full / fire / tilt flags     -> full / fire / tilt (boolean extras)
//   low-battery flag             -> lowBattery (boolean extra; NOT vocabulary
//                                   `battery`, which is volts — the device only
//                                   reports a threshold flag, not a voltage)
//   GPS longitude / latitude     -> position.longitude / position.latitude
//
// Upstream sign bug (corrected here): upstream computes the tilt angle sign as
// `bytes[s] & (0x0f === 0x00) ? bytes[m] : 0 - bytes[m]`. `(0x0f === 0x00)` is a
// constant `false`, so `bytes[s] & false` is always 0 (falsy) and upstream
// always negates the magnitude. The clear intent is a sign nibble: a zero low
// nibble on the sign byte means a positive angle, otherwise negative. We
// implement that.
//
// Out-of-range GPS coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed frame mis-decoding the packed float fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// IEEE754 single-precision: reconstruct a float from its 32-bit integer bits.
function hex2float(num) {
  var sign = num & 0x80000000 ? -1 : 1;
  var exponent = ((num >> 23) & 0xff) - 127;
  var mantissa = 1 + (num & 0x7fffff) / 0x7fffff;
  return sign * mantissa * Math.pow(2, exponent);
}

// 4 little-endian bytes -> IEEE754 float.
function floatLE(bytes, i) {
  var bits = (bytes[i + 3] << 24) + (bytes[i + 2] << 16) + (bytes[i + 1] << 8) + bytes[i];
  return hex2float(bits);
}

// Signed tilt angle: sign byte low nibble 0 -> positive, otherwise negative.
function tiltAngle(signByte, magByte) {
  var magnitude = magByte;
  if ((signByte & 0x0f) !== 0) {
    return -magnitude;
  }
  return magnitude;
}

function addPosition(data, lon, lat) {
  var position = {};
  var lonR = round(lon, 6);
  var latR = round(lat, 6);
  if (latR >= -90 && latR <= 90) {
    position.latitude = latR;
  }
  if (lonR >= -180 && lonR <= 180) {
    position.longitude = lonR;
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }
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
    var data17 = {
      fillDistanceMm: (bytes[5] << 8) + bytes[6],
      air: { temperature: bytes[8] },
      tiltAngle: tiltAngle(bytes[9], bytes[10]),
      full: Boolean(bytes[11] >> 4),
      fire: Boolean(bytes[11] & 0x0f),
      tiltAlarm: Boolean(bytes[12] >> 4),
      lowBattery: Boolean(bytes[12] & 0x0f)
    };
    return { data: data17 };
  }

  if (bytes.length === 25) {
    if (bytes[3] === 0x03) {
      // Parameter/config confirmation frame — device settings, not a measurement.
      return { errors: ['parameter confirmation frame carries no normalized measurement'] };
    }
    var data25 = {
      fillDistanceMm: (bytes[5] << 8) + bytes[6],
      air: { temperature: bytes[16] },
      tiltAngle: tiltAngle(bytes[17], bytes[18]),
      full: Boolean(bytes[19] >> 4),
      fire: Boolean(bytes[19] & 0x0f),
      tiltAlarm: Boolean(bytes[20] >> 4),
      lowBattery: Boolean(bytes[20] & 0x0f)
    };
    addPosition(data25, floatLE(bytes, 8), floatLE(bytes, 12));
    return { data: data25 };
  }

  return { errors: ['wrong length (expected 17 or 25 bytes)'] };
}
