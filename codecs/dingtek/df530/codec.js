// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF530 (LoRaWAN ultrasonic tank /
// bin level sensor with an optional on-board GNSS receiver). The GPS-enabled
// uplink carries a live latitude/longitude fix alongside the fill level,
// internal temperature and a low-battery flag.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df530.js, attributed in
// NOTICE). The upstream field extraction (fixed big-endian level / frame
// counter and little-endian IEEE754 float32 lat/lon) is reproduced faithfully;
// only the JSON shape is re-authored to the normalized vocabulary (never the
// upstream output object).
//
// All uplinks arrive on fPort 3:
//   17 bytes                       Heartbeat, no GPS fix.
//   25 bytes, bytes[3] == 0x03     Parameter report (interval / alarm), no fix.
//   25 bytes, bytes[3] != 0x03     Heartbeat WITH GPS fix.
//
// GPS frame:
//   latitude/longitude are signed decimal degrees (WGS84), decoded from a
//     little-endian IEEE754 float32 and rounded to the device's 1e-6 degree
//     resolution. Out-of-range coordinates (|lat| > 90, |lon| > 180) are
//     suppressed, guarding against a malformed frame over-reading the field.
//   temperature -> air.temperature (degrees C, whole-degree resolution).
//   battery is a LOW-BATTERY FLAG upstream, not a voltage; it is surfaced as
//     the camelCase extra batteryLow (never pushed into vocabulary `battery`).
//   level (mm) / empty / frameCounter -> camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// IEEE754 little-endian float32 (matches the upstream hex2float reconstruction).
function hex2float(num) {
  var sign = num & 0x80000000 ? -1 : 1;
  var exponent = ((num >> 23) & 0xff) - 127;
  var mantissa = 1 + (num & 0x7fffff) / 0x7fffff;
  return sign * mantissa * Math.pow(2, exponent);
}

function decodeHeartbeat(bytes, hasGps) {
  var data = {};
  var b = bytes;

  // Fill level (mm), big-endian.
  data.levelMm = (b[5] << 8) + b[6];

  var tempIndex, emptyIndex, batteryIndex, fcIndex;
  if (hasGps) {
    var lonBits = (b[11] << 24) + (b[10] << 16) + (b[9] << 8) + b[8];
    var latBits = (b[15] << 24) + (b[14] << 16) + (b[13] << 8) + b[12];
    var lon = round(hex2float(lonBits), 6);
    var lat = round(hex2float(latBits), 6);

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

    tempIndex = 16;
    emptyIndex = 19;
    batteryIndex = 20;
    fcIndex = 21;
  } else {
    tempIndex = 8;
    emptyIndex = 11;
    batteryIndex = 12;
    fcIndex = 13;
  }

  data.air = { temperature: b[tempIndex] };
  data.empty = Boolean(b[emptyIndex] >> 4);
  data.batteryLow = Boolean(b[batteryIndex] & 0x0f);
  data.frameCounter = (b[fcIndex] << 8) + b[fcIndex + 1];

  return { data: data };
}

function decodeParameters(bytes) {
  var b = bytes;
  // bytes[7]: 1-60 -> minutes, 61-84 -> (value - 60) hours.
  var interval = b[7];
  var data = {};
  if (interval > 60) {
    data.periodicUploadIntervalHours = interval - 60;
  } else {
    data.periodicUploadIntervalMinutes = interval;
  }
  data.emptyAlarmThresholdCm = b[9];
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (bytes.length === 17) {
    return decodeHeartbeat(bytes, false);
  }
  if (bytes.length === 25) {
    if (bytes[3] === 0x03) {
      return decodeParameters(bytes);
    }
    return decodeHeartbeat(bytes, true);
  }

  return { errors: ['wrong length (expected 17 or 25 bytes)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "df530";
  }
  return result;
}
