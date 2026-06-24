// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900A01O1 (Wireless Temperature /
// Humidity / Shock Sensor), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900a01o1.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Despite the TTN catalog title ("Water leak"), this device reports ambient
// climate plus a shock/tamper alarm and carries no leak channel. fPort 22
// carries device reports: bytes[0] is the frame version, bytes[1..2] the 16-bit
// big-endian device type (0x0111 == 273 == R900A01O1) and bytes[3] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame: bytes[4] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`) -> battery (V);
// bytes[5..6] is temperature in 0.01 C two's-complement -> air.temperature;
// bytes[7..8] is humidity in 0.01 % -> air.relativeHumidity; bytes[9] is a
// threshold-alarm bitmap (low/high temperature, low/high humidity), each
// surfaced as a camelCase extra; bytes[10] is the shock/tamper alarm state
// (0x00 == no alarm, non-zero == alarm) -> action.motion.detected (shock ==
// movement), also surfaced as the camelCase extra `tamperAlarm`. Config
// responses (fPort 23) carry no measurement.

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
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
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

  // Bytes 5..6: temperature in 0.01 C (two's-complement); 7..8: humidity 0.01 %.
  var air = {};
  air.temperature = decodeTemperature(bytes[5], bytes[6]);
  air.relativeHumidity = round(((bytes[7] << 8) | bytes[8]) / 100, 2);
  data.air = air;

  // Byte 9: threshold-alarm bitmap. Categorical, surfaced as camelCase extras.
  var flags = bytes[9];
  data.lowTemperatureAlarm = flags & 0x01 ? true : false;
  data.highTemperatureAlarm = flags >> 1 & 0x01 ? true : false;
  data.lowHumidityAlarm = flags >> 2 & 0x01 ? true : false;
  data.highHumidityAlarm = flags >> 3 & 0x01 ? true : false;

  // Byte 10: shock/tamper alarm. Shock == movement -> action.motion.detected;
  // also surfaced as the camelCase extra `tamperAlarm`.
  var alarm = bytes[10] !== 0x00;
  data.action = {
    motion: {
      detected: alarm
    }
  };
  data.tamperAlarm = alarm;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900a01o1";
  }
  return result;
}
