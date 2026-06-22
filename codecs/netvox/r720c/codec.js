// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R720C (Wireless Air Pressure and
// Temperature Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r720c.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x70 == 112 == R720C) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`), bytes[4..7] are barometric
// air pressure as a 32-bit big-endian raw value in pascals (/100 -> hPa) ->
// air.pressure, and bytes[8..9] are temperature in 0.01 C (16-bit big-endian,
// two's-complement) -> air.temperature. The upstream reference example decodes
// 0x00018BCD/100 = 1013.25 hPa (standard sea-level atmospheric pressure),
// confirming this is a genuine atmospheric barometer. Config responses
// (fPort 7) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeTemperature(hi, lo) {
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return round(raw / 100, 2);
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
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

  // Bytes 4-7: barometric air pressure, 32-bit big-endian raw value in pascals;
  // /100 -> hPa. Accumulated in floating point rather than with a 32-bit left
  // shift (which would overflow JS bitwise ops).
  var pa = (bytes[4] * 16777216) + (bytes[5] * 65536) + (bytes[6] * 256) + bytes[7];

  data.air = {
    pressure: round(pa / 100, 2),
    // Bytes 8-9: temperature in 0.01 C (16-bit big-endian, two's-complement).
    temperature: decodeTemperature(bytes[8], bytes[9])
  };

  return { data: data };
}
