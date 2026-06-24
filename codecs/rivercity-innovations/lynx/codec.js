// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the RiverCity Innovations Lynx (micro LoRaWAN
// GPS asset tracker: on-device GNSS position fix, heading, an in-trip motion
// flag, battery voltage, and an ambient temperature reading; plus version,
// sleep-time and peripheral configuration frames).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/rivercity-innovations/lynx.js,
// attributed in NOTICE). The upstream field extraction (fixed big-endian binary
// layout) is reproduced faithfully; only the JSON shape is re-authored to the
// normalized vocabulary (never the upstream decoded output).
//
// The Lynx multiplexes frame types onto LoRaWAN FPorts:
//   fPort 2  Regular position update  — int32 BE lat/lon * 1e-6, status, heading, temp
//   fPort 3  Version info             — LoRaWAN / firmware version (no measurement)
//   fPort 4  Sleep-time info          — configuration echo (no measurement)
//   fPort 5  Peripheral info          — configuration echo (no measurement)
//
// fPort 2 position frame (11 bytes):
//   bytes 0..3  signed int32 BE latitude  in microdegrees  -> position.latitude
//   bytes 4..7  signed int32 BE longitude in microdegrees  -> position.longitude
//   byte  8     bit7 inTrip   -> action.motion.detected (unit is on a trip)
//               bit6 fixFailed: when set the carried lat/lon are a STALE cached
//                 fix, not a live GNSS solution. We do NOT publish position.* in
//                 that case (it would misrepresent a cached coordinate as a
//                 fresh fix); the coordinates are surfaced as cachedLatitude /
//                 cachedLongitude extras with a warning.
//               bits 0..5 batteryCode -> battery = (code + 20) / 10 volts
//   byte  9     direction 0..255 -> headingDeg = code * 360/255 (extra)
//   byte  10    temperature -> air.temperature (upstream: subtract 128 if >127,
//                 then halve; reproduced faithfully)
//
// Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed frame over-reading the packed fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function readInt32BE(bytes, offset) {
  var v = bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
  if (v >= 0x80000000) {
    v -= 0x100000000;
  }
  return v;
}

function decodePosition(bytes) {
  var data = {};
  var warnings = [];

  var lat = round(readInt32BE(bytes, 0) / 1e6, 6);
  var lon = round(readInt32BE(bytes, 4) / 1e6, 6);

  var status = bytes[8];
  var inTrip = (status & 0x80) !== 0;
  var fixFailed = (status & 0x40) !== 0;
  var batteryCode = status & 0x3f;

  data.battery = round((batteryCode + 20) / 10, 2);
  data.action = { motion: { detected: inTrip } };
  data.headingDeg = round(bytes[9] * 360 / 255, 6);
  data.fixFailed = fixFailed;

  var temp = bytes[10];
  if (temp > 127) {
    temp -= 128;
  }
  data.air = { temperature: temp / 2 };

  var latOk = lat >= -90 && lat <= 90;
  var lonOk = lon >= -180 && lon <= 180;

  if (fixFailed) {
    warnings.push('fix failed');
    if (latOk) {
      data.cachedLatitude = lat;
    }
    if (lonOk) {
      data.cachedLongitude = lon;
    }
  } else {
    var position = {};
    if (latOk) {
      position.latitude = lat;
    }
    if (lonOk) {
      position.longitude = lon;
    }
    if (position.latitude !== undefined || position.longitude !== undefined) {
      data.position = position;
    }
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (input.fPort === 2) {
    if (bytes.length < 11) {
      return { errors: ['fPort 2 position frame requires 11 bytes'] };
    }
    return decodePosition(bytes);
  }
  if (input.fPort === 3) {
    return { errors: ['fPort 3 version-info frame carries no normalized measurement'] };
  }
  if (input.fPort === 4) {
    return { errors: ['fPort 4 sleep-time frame carries no normalized measurement'] };
  }
  if (input.fPort === 5) {
    return { errors: ['fPort 5 peripheral-info frame carries no normalized measurement'] };
  }

  return { errors: ['unsupported FPort (expected 2 for position)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "rivercity-innovations";
    result.data.model = "lynx";
  }
  return result;
}
