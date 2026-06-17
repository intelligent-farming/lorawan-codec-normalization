// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R726 Series / RA07 Series air-quality
// sensors (R726xx), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/ra0715_r72615_ra0715y_r72615a.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x09 == R726 Series) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement.
//
// For a measurement frame, bytes[3] is battery voltage in 0.1 V (high bit
// flags low battery, surfaced as the camelCase extra `lowBattery`). The three
// 16-bit big-endian sensor slots bytes[4..5], bytes[6..7] and bytes[8..9] are
// re-interpreted per report type; a slot of 0xFFFF means "no sensor" and is
// omitted. The R726 family is a modular air-quality bus, so most report types
// carry pollutant / soil / water channels with no vocabulary key. This codec
// normalizes only the climate / air-quality channels this device declares:
//
//   reportType 0x07 -> CO2 in slot1 (0.1 ppm units) -> air.co2 (ppm)
//   reportType 0x0C -> Temperature in slot1 (0.01 C, two's-complement) ->
//                      air.temperature; Humidity in slot2 (0.01 %) ->
//                      air.relativeHumidity
//
// Any other measurement report type carries only channels outside this
// device's vocabulary (PM, gases, soil, water, VOC) and is reported as an
// error. Config responses (fPort 7) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function readU16(hi, lo) {
  return (hi << 8) | lo;
}

function decodeTemperature(raw) {
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

  var slot1 = readU16(bytes[4], bytes[5]);
  var slot2 = readU16(bytes[6], bytes[7]);

  var air = {};

  if (reportType === 0x07) {
    // CO2 / NH3 / Noise report. Only CO2 (slot1, 0.1 ppm units) maps to the
    // vocabulary; NH3 and Noise have no vocabulary key and are dropped.
    if (slot1 === 0xffff) {
      return { errors: ['CO2 sensor reported no measurement (0xFFFF)'] };
    }
    air.co2 = round(slot1 / 10, 1);
  } else if (reportType === 0x0c) {
    // Temperature / Humidity / WindSpeed report. Temperature (slot1, 0.01 C,
    // two's-complement) and Humidity (slot2, 0.01 %) map to the vocabulary;
    // WindSpeed is dropped (wind is not a declared category for this device).
    if (slot1 === 0xffff && slot2 === 0xffff) {
      return { errors: ['temperature/humidity sensor reported no measurement (0xFFFF)'] };
    }
    if (slot1 !== 0xffff) {
      air.temperature = decodeTemperature(slot1);
    }
    if (slot2 !== 0xffff) {
      air.relativeHumidity = round(slot2 / 100, 2);
    }
  } else {
    // 0x01-0x06, 0x08-0x0B, 0x0D-0x10: PM, particle counts, gases, soil, water
    // and VOC channels with no vocabulary key for this device.
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no climate/air-quality measurement'] };
  }

  data.air = air;
  return { data: data };
}
