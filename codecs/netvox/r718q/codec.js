// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718Q (Wireless Short-Range Occupancy
// Sensor, PIR), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da_r718db_r718j_r718lb_r718mba.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries device reports: bytes[1] is the device-type id (91 ==
// R718Q) and bytes[2] is the report-type discriminator. reportType 0x00 is a
// device-info/startup frame (software / hardware version + datecode) and
// carries no measurement -> error.
//
// For a status frame (bytes[2] != 0x00):
//   byte 3: battery voltage in 0.1 V. The high bit (0x80) flags low battery,
//           surfaced as the camelCase extra `lowBattery`; the low 7 bits are
//           the voltage -> battery (V).
//   byte 4: occupancy/PIR state (upstream `status`). The R718Q is a single
//           PIR/occupancy node; this byte is the detection flag (0x00 == clear,
//           non-zero == occupied/motion detected) -> action.motion.detected.
//
// Config responses (fPort 7) carry no measurement -> error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 5) {
    return { errors: ['expected at least 5 bytes, got ' + bytes.length] };
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

  // Byte 4: occupancy/motion state. 0x00 == clear, non-zero == detected.
  data.action = {
    motion: {
      detected: bytes[4] !== 0x00
    }
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718q";
  }
  return result;
}
