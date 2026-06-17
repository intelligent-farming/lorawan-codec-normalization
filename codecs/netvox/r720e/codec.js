// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R720E (Wireless TVOC Detection Sensor),
// data report on fPort 6.
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r720e.js, attributed
// in NOTICE). The wire format is faithfully ported from upstream; the
// normalization (vocabulary keys, units, camelCase extras) is authored here —
// do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0xA5 == 165 == R720E) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`) -> battery; bytes[4..5] are
// the TVOC/VOC reading (16-bit big-endian), which the vocabulary does not model
// and so is surfaced as the camelCase extra `tvoc` (with `tvocUnit` carrying
// the unit from bytes[10]: 0x00 -> "ppb", else "index"); bytes[6..7] are
// temperature in 0.01 C (16-bit big-endian, two's-complement) ->
// air.temperature; and bytes[8..9] are relative humidity in 0.01 % (16-bit
// big-endian) -> air.relativeHumidity. Config responses (fPort 7) carry no
// measurement.

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
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
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

  // Bytes 6-7: temperature in 0.01 C (16-bit big-endian, two's-complement).
  // Bytes 8-9: relative humidity in 0.01 % (16-bit big-endian).
  data.air = {
    temperature: decodeTemperature(bytes[6], bytes[7]),
    relativeHumidity: round(((bytes[8] << 8) | bytes[9]) / 100, 2)
  };

  // Bytes 4-5: TVOC/VOC reading; the vocabulary has no key for it, so surface
  // it as a camelCase extra. Byte 10 selects the unit (0x00 -> ppb, else index).
  data.tvoc = (bytes[4] << 8) | bytes[5];
  data.tvocUnit = bytes[10] === 0x00 ? 'ppb' : 'index';

  return { data: data };
}
