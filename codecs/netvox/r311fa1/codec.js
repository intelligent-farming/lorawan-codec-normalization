// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311FA1 (Wireless 3-axis Accelerometer
// Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718e.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports. bytes[0] is the frame version,
// bytes[1] the device type (199 == 0xC7 == R311FA1) and bytes[2] the
// report-type discriminator:
//   - 0x00: device-info / startup frame (SW/HW version + datecode). No
//     measurement -> reported as an error.
//   - 0x01: acceleration frame. bytes[3] is battery voltage in 0.1 V (high bit
//     flags low battery, surfaced as the camelCase extra `lowBattery`).
//     bytes[4..9] are three little-endian 16-bit values, each the high 16 bits
//     of an IEEE-754 float32 ("bfloat16"): X = bytes[5]<<8|bytes[4],
//     Y = bytes[7]<<8|bytes[6], Z = bytes[9]<<8|bytes[8], in g ->
//     vibration.accelerationX/Y/Z.
//   - any other report type (e.g. 0x02): velocity frame. bytes[3..8] are three
//     little-endian bfloat16 values: X = bytes[4]<<8|bytes[3],
//     Y = bytes[6]<<8|bytes[5], Z = bytes[8]<<8|bytes[7], in mm/s ->
//     vibration.velocityX/Y/Z. (The upstream optional temperature tail applies
//     only to device type 0x1C / R718E, never this device, so it is not
//     decoded here.)
// Velocity frames carry no battery byte. Config / threshold / restore responses
// arrive on fPort 7 and carry no measurement -> reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Decode the 16-bit value as the high 16 bits of an IEEE-754 binary32
// (sign + 8-bit exponent + top 7 mantissa bits), matching the upstream
// float32Process. Manual IEEE-754 bit math; no binary typed-array helpers in
// the sandbox.
function bfloat16(h) {
  var sign = (h & 0x8000) >> 15;
  var exp = (h & 0x7f80) >> 7;
  var fraction = (h & 0x007f) << 16;
  if (exp === 0) {
    return (sign ? -1 : 1) * Math.pow(2, -126) * (fraction / Math.pow(2, 23));
  } else if (exp === 0xff) {
    return fraction ? NaN : ((sign ? -1 : 1) * Infinity);
  }
  return (sign ? -1 : 1) * Math.pow(2, exp - 127) * (1 + (fraction / Math.pow(2, 23)));
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['config response on fPort 7 (no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  if (reportType === 0x01) {
    // Acceleration frame. bytes[3] battery in 0.1 V; high bit = low battery.
    if (bytes[3] & 0x80) {
      data.lowBattery = true;
    }
    data.battery = round((bytes[3] & 0x7f) / 10, 1);
    data.vibration = {
      accelerationX: round(bfloat16((bytes[5] << 8) | bytes[4]), 6),
      accelerationY: round(bfloat16((bytes[7] << 8) | bytes[6]), 6),
      accelerationZ: round(bfloat16((bytes[9] << 8) | bytes[8]), 6)
    };
    return { data: data };
  }

  // Velocity frame (any non-info, non-acceleration report type). No battery byte.
  data.vibration = {
    velocityX: round(bfloat16((bytes[4] << 8) | bytes[3]), 6),
    velocityY: round(bfloat16((bytes[6] << 8) | bytes[5]), 6),
    velocityZ: round(bfloat16((bytes[8] << 8) | bytes[7]), 6)
  };
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r311fa1";
  }
  return result;
}
