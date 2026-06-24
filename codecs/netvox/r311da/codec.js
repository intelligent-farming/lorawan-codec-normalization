// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311DA (Wireless Vibration Sensor,
// Rolling Ball Type), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/r311da-codec.yaml, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries device reports: bytes[0] is the frame version, bytes[1] the
// 8-bit device type (168 == R311DA) and bytes[2] the report-type discriminator.
// reportType 0x00 is a device-info/startup frame (software / hardware version +
// datecode) and carries no measurement -> error. For a status frame, bytes[3]
// is battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`) -> battery (V), and bytes[4] is the vibration
// state (0x00 == no vibration, non-zero == vibration detected) ->
// action.motion.detected (boolean). This device reports a vibration state, not
// an event count. Config responses (fPort 7) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
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

  // Byte 4: vibration state. 0x00 == no vibration, non-zero == vibration
  // detected. The device reports a state, not an event count.
  data.action = {
    motion: {
      detected: bytes[4] !== 0x00
    }
  };

  return { data: data };
}
