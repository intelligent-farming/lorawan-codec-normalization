// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718AB (Wireless Temperature and Humidity
// Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/
// r711_r718a_r718ab_r720a.js, attributed in NOTICE). Author the normalization
// here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0]=version, bytes[1]=deviceType,
// bytes[2]=reportType. reportType 0x00 is a device-info frame (software/hardware
// version + datecode) and carries no measurement. Otherwise bytes[3] is battery
// voltage in 0.1 V with the high bit (0x80) flagging low battery (surfaced as
// the camelCase extra `lowBattery`); bytes[4..5] are temperature (air.temperature,
// 0.01 C, 16-bit two's-complement big-endian) and bytes[6..7] are relative
// humidity (air.relativeHumidity, 0.01 %, 16-bit big-endian). Config responses
// (fPort 7) carry no measurement and are reported as errors.

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
  if (bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + bytes.length] };
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

  // Bytes 4-5: temperature (0.01 C, 16-bit two's-complement big-endian).
  // Bytes 6-7: relative humidity (0.01 %, 16-bit big-endian).
  data.air = {
    temperature: decodeTemperature(bytes[4], bytes[5]),
    relativeHumidity: round(((bytes[6] << 8) | bytes[7]) / 100, 2)
  };

  return { data: data };
}
