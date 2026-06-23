// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900A03O1 (Wireless Water Leak Sensor,
// digital-output variant), status report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900a03o1.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device frames: bytes[0] is the frame version, bytes[1..2]
// the big-endian device type (0x0113 == 275 == R900A03O1) and bytes[3] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement.
// For a status report, bytes[4] is battery voltage in 0.1 V (high bit flags
// low battery, surfaced as the camelCase extra `lowBattery`), bytes[5] is the
// leak state (0x00 == no leak, non-zero == leak detected) -> water.leak, and
// bytes[6] is the shock/tamper alarm (0x00 == no alarm, non-zero == alarm),
// surfaced as the camelCase extra `shockTamperAlarm`. This device exposes a
// single leak channel and carries no temperature sensor. Config command
// responses (fPort 23) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 7) {
    return { errors: ['expected at least 7 bytes, got ' + bytes.length] };
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

  // Byte 6: shock/tamper alarm (categorical), surfaced as a camelCase extra.
  data.shockTamperAlarm = bytes[6] !== 0x00;

  // Byte 5: leak state (0x00 == no leak, non-zero == leak detected).
  data.water = {
    leak: bytes[5] !== 0x00
  };

  return { data: data };
}
