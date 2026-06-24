// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900A02O1 (Temperature + Shock / Shock-
// Tamper Sensor), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900a02o1.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0112 == 274 == R900A02O1) and bytes[3]
// the report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame: bytes[4] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`) -> battery (V);
// bytes[5..6] is temperature in 0.01 C two's-complement -> air.temperature (no
// humidity, so this is a motion device, not climate); bytes[7] carries the
// low/high temperature threshold-alarm bits (categorical, surfaced as the
// camelCase extras `lowTemperatureAlarm` / `highTemperatureAlarm`); bytes[8] is
// the shock/movement alarm state (0x00 == no alarm, non-zero == shock) ->
// action.motion.detected. Config responses (fPort 23) carry no measurement.

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

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 9) {
    return { errors: ['expected at least 9 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[3];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 4: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[4] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[4] & 0x7f) / 10, 1);

  // Bytes 5..6: temperature, 0.01 C two's-complement.
  data.air = {
    temperature: decodeTemperature(bytes[5], bytes[6])
  };

  // Byte 7: temperature threshold-alarm bits (categorical extras).
  data.lowTemperatureAlarm = bytes[7] & 0x01 ? true : false;
  data.highTemperatureAlarm = bytes[7] >> 1 & 0x01 ? true : false;

  // Byte 8: shock/movement alarm state. Non-zero == shock detected.
  data.action = {
    motion: {
      detected: bytes[8] !== 0x00
    }
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900a02o1";
  }
  return result;
}
