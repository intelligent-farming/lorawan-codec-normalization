// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900NAC6 (Shock / Shock-Tamper sensor),
// data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900nac6.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0102 == 258 == R900NAC6) and bytes[3]
// the report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame, bytes[4] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`) -> battery (V).
// bytes[5..22] carry six 24-bit current readings and bytes[23..24] a current
// alarm bitmask; this is a shock/movement device, not a current monitor, and
// those vendor diagnostics are not part of the motion model, so they are not
// surfaced. byte[25] is the shock/tamper alarm state (0x00 == no alarm, 0x01 ==
// alarm) -> action.motion.detected (boolean). Config responses (fPort 23) carry
// no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 26) {
    return { errors: ['expected at least 26 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[3];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 4: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[4] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[4] & 0x7f) / 10, 1);

  // Byte 25: shock/tamper alarm state. 0x00 == no alarm, non-zero == alarm.
  // This is the device's shock/movement event -> motion detected.
  data.action = {
    motion: {
      detected: bytes[25] !== 0x00
    }
  };

  return { data: data };
}
