// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900NAC1 (Wireless Shock/Movement
// Sensor), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900nac1.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0100 == 256 == R900NAC1) and bytes[3]
// the report-type discriminator. reportType 0x00 is a device-info/startup
// frame (software / hardware version + datecode) and carries no measurement
// -> error. For a status frame, bytes[4] is battery voltage in 0.1 V (high bit
// flags low battery, surfaced as the camelCase extra `lowBattery`) ->
// battery (V); bytes[5..7] are a 24-bit big-endian loop-current reading in mA,
// surfaced as the camelCase extra `current1Ma`; bytes[8] bit0 is a
// low-current alarm and bit1 a high-current alarm, surfaced as the camelCase
// extras `lowCurrentAlarm` / `highCurrentAlarm`; and bytes[9] is the
// shock/tamper alarm state (0x00 == no shock, non-zero == shock/movement
// detected). On this device the shock/tamper signal IS the movement signal
// (the configurable "shock sensor sensitivity" governs it), so it maps to the
// motion vocabulary key action.motion.detected (boolean). Config responses
// (fPort 23) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
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

  // Bytes 5-7: 24-bit big-endian loop current in mA. Vendor diagnostic with no
  // vocabulary key -> camelCase extra.
  data.current1Ma = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];

  // Byte 8: current alarm bits. bit0 low-current, bit1 high-current.
  data.lowCurrentAlarm = (bytes[8] & 0x01) !== 0;
  data.highCurrentAlarm = (bytes[8] >> 1 & 0x01) !== 0;

  // Byte 9: shock/tamper (movement) alarm. 0x00 == no shock, non-zero ==
  // shock/movement detected -> action.motion.detected.
  data.action = {
    motion: {
      detected: bytes[9] !== 0x00
    }
  };

  return { data: data };
}
