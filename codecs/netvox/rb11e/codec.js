// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox RB11E (Wireless Occupancy/Temperature/
// Light multi-sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/rb11e.js, attributed
// in NOTICE). Battery is volts (high bit of the voltage byte is the low-battery
// flag, surfaced as the camelCase extra `lowBattery`); temperature (16-bit BE,
// 0.01 C, two's-complement) -> air.temperature; illuminance (16-bit BE lux) ->
// air.lightIntensity; the Occupy byte (PIR) -> action.motion.detected; the
// disassembled/tamper byte -> the camelCase extra `tamperAlarm`. Device-info
// frames (byte2 == 0) and config frames (fPort 7) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
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

  // Bytes 4-5: temperature in 0.01 C, 16-bit big-endian, two's-complement.
  var rawTemp = (bytes[4] << 8) | bytes[5];
  if (bytes[4] & 0x80) {
    rawTemp = rawTemp - 0x10000;
  }
  data.air = { temperature: round(rawTemp / 100, 2) };

  // Bytes 6-7: illuminance (lux), 16-bit big-endian.
  data.air.lightIntensity = (bytes[6] << 8) | bytes[7];

  // Byte 8: occupancy (PIR) flag.
  data.action = { motion: { detected: bytes[8] !== 0 } };

  // Byte 9: disassembled/tamper alarm flag (device-specific extra).
  data.tamperAlarm = bytes[9] !== 0;

  return { data: data };
}
