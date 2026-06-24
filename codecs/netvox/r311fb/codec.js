// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311FB (Wireless Vibration / Activity
// Event Counter), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r311fb_r718mbb_r730mbb.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries device reports: bytes[0] is the frame version, bytes[1] the
// 8-bit device type (80 == R311FB) and bytes[2] the report-type discriminator.
// reportType 0x00 is a device-info/startup frame (software / hardware version +
// datecode) and carries no measurement -> error. For a status frame, bytes[3]
// is battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`) -> battery (V), and bytes[4..7] are a 32-bit
// big-endian cumulative activity/vibration event counter (upstream `WorkCount`)
// -> action.motion.count, with action.motion.detected derived as count > 0.
// Unlike the rolling-ball R311DA (which reports an instantaneous vibration
// state), the R311FB reports a cumulative event count. Config responses
// (fPort 7) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
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

  // Bytes 4..7: 32-bit big-endian cumulative activity/vibration event counter.
  // `>>> 0` would be post-ES2017-fine but unnecessary here: the value fits in a
  // safe integer and is non-negative because the top byte is masked into a sum.
  var count = (bytes[4] * 16777216) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];

  data.action = {
    motion: {
      detected: count > 0,
      count: count
    }
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r311fb";
  }
  return result;
}
