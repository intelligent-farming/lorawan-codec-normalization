// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718MBB (Wireless Activity/Vibration
// Event Counter), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/r311fb_r718mbb_r730mbb.js, attributed in NOTICE).
// Author the normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x2b == 43 == R718MBB) and bytes[2] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement. For a
// measurement frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`) and bytes[4..7] are a
// 32-bit big-endian cumulative vibration/activity event count (the upstream
// `WorkCount`). This maps to the `motion` category: action.motion.count is the
// cumulative event count and action.motion.detected is true when any event has
// been recorded (count != 0). Config responses (fPort 7) and the device-info
// frame carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4..7: 32-bit big-endian cumulative vibration/activity event count
  // (upstream WorkCount). Assemble unsigned (>>> 0 clears the sign bit the
  // bitwise OR would otherwise set for counts above 0x7fffffff).
  var count = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  data.action = {
    motion: {
      detected: count !== 0,
      count: count
    }
  };

  return { data: data };
}
