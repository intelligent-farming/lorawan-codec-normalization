// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900A01, data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900a01.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Despite the "Water Leak Sensor" product name, the R900A01 wire format decodes
// temperature, humidity and a shock/tamper alarm — it is a climate + shock
// sensor, not a leak sensor.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0109 == 265 == R900A01) and bytes[3] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame:
//   byte 4      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//               surfaced as the camelCase extra `lowBattery`. The remaining 7
//               bits hold the voltage -> battery (V).
//   bytes 5..6  signed big-endian temperature in 0.01 C (two's complement when
//               byte 5 high bit set) -> air.temperature (C).
//   bytes 7..8  unsigned big-endian humidity in 0.01 % -> air.relativeHumidity.
//   byte 9      temperature/humidity threshold-alarm bitfield:
//                 bit0 low-temperature, bit1 high-temperature,
//                 bit2 low-humidity, bit3 high-humidity
//               surfaced as the camelCase extras
//               lowTemperatureAlarm / highTemperatureAlarm /
//               lowHumidityAlarm / highHumidityAlarm (booleans).
//   byte 10     shock/tamper alarm state (0x00 == no alarm, non-zero == alarm)
//               -> action.motion.detected (boolean; the device's movement/shock
//               trigger) and the camelCase extra `tamperAlarm` (same flag, kept
//               under its device-specific name).
// Config responses (fPort 23) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
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

  // Bytes 5..6: signed big-endian temperature in 0.01 C.
  var rawTemp = (bytes[5] << 8) | bytes[6];
  if (bytes[5] & 0x80) {
    rawTemp = rawTemp - 0x10000;
  }
  data.air = {
    temperature: round(rawTemp / 100, 2),
    // Bytes 7..8: unsigned big-endian humidity in 0.01 %.
    relativeHumidity: round(((bytes[7] << 8) | bytes[8]) / 100, 2)
  };

  // Byte 9: temperature/humidity threshold-alarm bitfield.
  data.lowTemperatureAlarm = (bytes[9] & 0x01) !== 0;
  data.highTemperatureAlarm = (bytes[9] >> 1 & 0x01) !== 0;
  data.lowHumidityAlarm = (bytes[9] >> 2 & 0x01) !== 0;
  data.highHumidityAlarm = (bytes[9] >> 3 & 0x01) !== 0;

  // Byte 10: shock/tamper alarm state (0x00 == no alarm, non-zero == alarm).
  var shock = bytes[10] !== 0x00;
  data.action = {
    motion: {
      detected: shock
    }
  };
  data.tamperAlarm = shock;

  return { data: data };
}
