// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718WBA (Wireless Temperature and
// Humidity Sensor & Water Leakage), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718wba.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries the periodic data report. byte0 = protocol version,
// byte1 = device type (0x6B = R718WBA), byte2 = report type. report type 0x00
// is the startup/device-info frame (no measurement). For status reports:
// byte3 = battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`); bytes4-5 = temperature, 16-bit BE in 0.01 C
// two's-complement -> air.temperature; bytes6-7 = humidity, 16-bit BE in 0.01 %
// -> air.relativeHumidity; byte8 = water-leak status (nonzero = leak) ->
// water.leak. Config responses (fPort 7) carry no measurement.

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
  if (bytes.length < 9) {
    return { errors: ['expected at least 9 bytes, got ' + bytes.length] };
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

  // Bytes 4-5: temperature, 16-bit BE, 0.01 C two's-complement.
  // Bytes 6-7: humidity, 16-bit BE, 0.01 %.
  data.air = {
    temperature: decodeTemperature(bytes[4], bytes[5]),
    relativeHumidity: round(((bytes[6] << 8) | bytes[7]) / 100, 2)
  };

  // Byte 8: water-leak status (nonzero = leak detected).
  data.water = { leak: bytes[8] ? true : false };

  return { data: data };
}
