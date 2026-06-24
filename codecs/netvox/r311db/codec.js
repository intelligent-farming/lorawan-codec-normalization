// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311DB (Wireless Vibration Sensor, Spring
// Type), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da_r718db_r718j_r718lb_r718mba.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries device frames: bytes[1] is the device-type id (169 == R311DB)
// and bytes[2] is the report-type discriminator. When bytes[2] == 0x00 the frame
// is a device-info/startup report (software / hardware version + datecode) and
// carries no measurement -> error. Otherwise it is a status report: bytes[3] is
// battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`) -> battery (V), and bytes[4] is the vibration
// alarm state (0x00 == no vibration, non-zero == vibration detected) ->
// action.motion.detected. The wire format carries no event counter, so
// action.motion.count is not emitted. Config request/response frames on fPort 7
// carry no measurement -> error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['config report frame on fPort 7 (no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 5) {
    return { errors: ['expected at least 5 bytes, got ' + bytes.length] };
  }

  if (bytes[2] === 0x00) {
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
    result.data.model = "r311db";
  }
  return result;
}
