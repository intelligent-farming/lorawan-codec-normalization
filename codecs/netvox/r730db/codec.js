// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R730DB (Wireless Vibration Sensor), data
// report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da_r718db_r718j_r718lb_r718mba.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries device reports: bytes[0] is the frame version, bytes[1] the
// device type (139 == R730DB) and bytes[2] the report-type discriminator.
// reportType 0x00 is a device-info/startup frame (software / hardware version +
// datecode) and carries no measurement -> error. For a status frame, bytes[3]
// is battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`) -> battery (V), and bytes[4] is the vibration
// alarm state (0x00 == no vibration, non-zero == vibration detected) ->
// action.motion.detected (boolean). This device reports a single vibration
// state and no event count. Config requests/responses (fPort 7) carry no
// measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
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

  // Byte 4: vibration alarm state. 0x00 == no vibration, non-zero == detected.
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
    result.data.model = "r730db";
  }
  return result;
}
