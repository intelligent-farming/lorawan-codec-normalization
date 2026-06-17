// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R720B (Wireless Temperature and Humidity
// Sensor with Activity Detection Sensor), data report on fPort 6.
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r711_r718a_r718ab_r720a.js,
// attributed in NOTICE), R720B (deviceType 0x6F == 111) branch. The wire format
// is faithfully ported from upstream; the normalization (vocabulary keys, units,
// camelCase extras) is authored here — do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x6F == 111 == R720B) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`) -> battery, bytes[4..5] are
// temperature in 0.01 C (16-bit big-endian, two's-complement) ->
// air.temperature, bytes[6..7] are relative humidity in 0.01 % (16-bit
// big-endian) -> air.relativeHumidity, and bytes[8] is the activity-detection
// alarm flag (surfaced as the camelCase extra `alarm`). Config responses
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

  // Bytes 4-5: temperature in 0.01 C (16-bit big-endian, two's-complement).
  // Bytes 6-7: relative humidity in 0.01 % (16-bit big-endian).
  data.air = {
    temperature: decodeTemperature(bytes[4], bytes[5]),
    relativeHumidity: round(((bytes[6] << 8) | bytes[7]) / 100, 2)
  };

  // Byte 8: activity-detection alarm flag (categorical extra).
  data.alarm = bytes[8] ? true : false;

  return { data: data };
}
