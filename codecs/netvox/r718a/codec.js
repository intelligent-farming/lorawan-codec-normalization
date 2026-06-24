// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718A (Wireless Temperature and Humidity
// Sensor for Low Temperature Environment), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/
// r711_r718a_r718ab_r720a.js, attributed in NOTICE). Author the normalization
// here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports; bytes[0]=version, bytes[1]=deviceType
// (R718A == 0x0B), bytes[2]=reportType. reportType 0x00 is a device-info frame
// (software/hardware version + datecode) and carries no measurement.
// Otherwise: bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`); bytes[4..5] are temperature
// (0.01 C, 16-bit big-endian two's-complement) -> air.temperature; bytes[6..7]
// are relative humidity (0.01 %, 16-bit big-endian) -> air.relativeHumidity.
// Config responses (fPort 7) and any other fPort carry no measurement and are
// reported as errors.

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (config response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + bytes.length] };
  }

  // bytes[2] is the report-type discriminator; 0x00 is a device-info frame.
  if (bytes[2] === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  var air = {};
  air.temperature = decodeTemperature(bytes[4], bytes[5]);
  air.relativeHumidity = round(((bytes[6] << 8) | bytes[7]) / 100, 2);

  data.air = air;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718a";
  }
  return result;
}
