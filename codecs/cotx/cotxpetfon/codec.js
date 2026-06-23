// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Cotx PetFon (LoRaWAN pet GPS tracker:
// on-device GNSS position fix plus a step ("paws") counter, a battery level
// field, and a working/run-time counter).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/cotx/cotxpetfon.js, attributed in
// NOTICE). The upstream field extraction (hex-string substring slicing + a
// binary-string run-time field) is reproduced faithfully; only the JSON shape
// is re-authored to the normalized vocabulary (never the upstream decoded
// output object).
//
// The first byte selects the frame type:
//   0xF1 (241)  GNSS fix frame — longitude, latitude, paws, battery, working
//   0xF0 (240)  no-fix frame   — paws, battery, working (no position)
//   0xF2 (242)  no-fix frame   — paws (alternate offset), battery, working
//
// 0xF1 field layout (hex offsets are over the byte->hex string, 2 chars/byte):
//   longitude  hex substr(12,8) = bytes 6..9, big-endian uint32 / 1e6 deg.
//              Sign: when (bytes[6] & 0x80) the raw value is taken as a
//              signed 32-bit wraparound (raw - 0x100000000) before scaling.
//   latitude   hex substr(20,8) = bytes 10..13, same scaling/sign rule keyed
//              on (bytes[10] & 0x80).
//   paws       hex substr(32,8) = bytes 16..19 (step count, extra).
//   run_time   hex substr(40,8) = bytes 20..23, read as a binary string:
//                battery = bits slice(-21,-14)  (7-bit raw level, extra)
//                working = bits slice(-10)       (10-bit run-time, extra)
// 0xF0: paws at hex substr(12,8) = bytes 6..9; run_time as above.
// 0xF2: paws at hex substr(70,8) = bytes 35..38; run_time as above.
//
// Only the 0xF1 frame carries an on-device latitude/longitude fix, so only it
// emits position.* (gps-tracker). The 0xF0/0xF2 frames carry no fix and emit
// only the counters/level extras. Out-of-range coordinates (|lat| > 90,
// |lon| > 180) are suppressed, guarding against a malformed frame over-reading
// the packed fields.
//
// The upstream "battery" field is a raw 7-bit value (0..127) with no documented
// volt or percent scaling, so it is surfaced as the camelCase extra
// `batteryLevel` rather than the vocabulary `battery` (volts). No moving/motion
// flag is decoded by the wire format, so action.motion is not emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    s += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

// Big-endian uint32 from 8 hex chars, applying the upstream signed-wraparound
// when the supplied sign byte has its high bit set.
function signedDegrees(hex, offset, signByte) {
  var raw = parseInt(hex.substr(offset, 8), 16);
  if (signByte & 0x80) {
    raw = raw - parseInt('100000000', 16);
  }
  return raw / 1000000;
}

// Run-time field: hex substr(40,8) = bytes 20..23, interpreted as a binary
// string. battery = bits slice(-21,-14); working = bits slice(-10).
function decodeRunTime(hex, data) {
  var runTimeBit = parseInt(hex.substr(40, 8), 16).toString(2);
  data.batteryLevel = parseInt(runTimeBit.slice(-21, -14), 2);
  data.working = parseInt(runTimeBit.slice(-10), 2);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }

  var type = bytes[0] & 0xff;
  var hex = bytesToHex(bytes);

  if (type === 0xf1) {
    if (bytes.length < 24) {
      return { errors: ['0xF1 GNSS fix frame requires 24 bytes'] };
    }
    var data = {};

    var lon = signedDegrees(hex, 12, bytes[6] & 0xff);
    var lat = signedDegrees(hex, 20, bytes[10] & 0xff);
    lon = round(lon, 6);
    lat = round(lat, 6);

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

    data.paws = parseInt(hex.substr(32, 8), 16);
    decodeRunTime(hex, data);
    return { data: data };
  }

  if (type === 0xf0) {
    if (bytes.length < 24) {
      return { errors: ['0xF0 frame requires 24 bytes'] };
    }
    var d0 = {};
    d0.paws = parseInt(hex.substr(12, 8), 16);
    decodeRunTime(hex, d0);
    return { data: d0 };
  }

  if (type === 0xf2) {
    if (bytes.length < 39) {
      return { errors: ['0xF2 frame requires 39 bytes'] };
    }
    var d2 = {};
    d2.paws = parseInt(hex.substr(70, 8), 16);
    decodeRunTime(hex, d2);
    return { data: d2 };
  }

  return { errors: ['unsupported frame type (expected 0xF0, 0xF1 or 0xF2)'] };
}
