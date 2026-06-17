// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox RA0716 (Wireless PM2.5 / Temperature /
// Humidity Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/ra0716.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x35 == 53 == RA0716) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`), bytes[4..5] are temperature in
// 0.01 C (16-bit big-endian, two's-complement) -> air.temperature, bytes[6..7]
// are relative humidity in 0.01 % (16-bit big-endian) -> air.relativeHumidity,
// and bytes[8..9] are PM2.5 in ug/m3 (16-bit big-endian) -> camelCase extra
// `pm25` (the vocabulary models no particulate-matter key). Config responses
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

  // Bytes 4-5: temperature in 0.01 C (16-bit big-endian, two's-complement).
  // Bytes 6-7: relative humidity in 0.01 % (16-bit big-endian).
  data.air = {
    temperature: decodeTemperature(bytes[4], bytes[5]),
    relativeHumidity: round(((bytes[6] << 8) | bytes[7]) / 100, 2)
  };

  // Bytes 8-9: PM2.5 in ug/m3 (16-bit big-endian). No vocabulary key models
  // particulate matter, so surface it as the camelCase extra `pm25`.
  data.pm25 = (bytes[8] << 8) | bytes[9];

  return { data: data };
}
