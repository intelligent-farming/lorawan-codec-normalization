// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718G (Wireless Light Sensor), data
// report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718g.js, attributed
// in NOTICE). Battery is volts (high bit of the voltage byte is the low-battery
// flag, surfaced as the camelCase extra `lowBattery`); illuminance (32-bit BE,
// bytes 4-7) -> air.lightIntensity (lux). Device-info (byte2 == 0) and config
// frames (fPort 7) carry no measurement.

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
  if (bytes[2] === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4-7: illuminance (lux), 32-bit big-endian, unsigned.
  var lux = (bytes[4] * 16777216) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];
  data.air = { lightIntensity: lux };

  return { data: data };
}
