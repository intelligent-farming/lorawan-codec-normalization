// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R31505 (R315 family - Wireless
// Temperature / Humidity / Internal Vibration / Tilt / Reed Switch / External
// Vibration Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r315.js, deviceType
// 0xD2 == "R315" branch; attributed in NOTICE). Author the normalization here;
// do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports; bytes[0] is the protocol version,
// bytes[1] the device type, bytes[2] the report-type discriminator. Battery is
// volts (high bit of bytes[3] is the low-battery flag, surfaced as the
// camelCase extra `lowBattery`). Report 0x01 carries temperature
// (air.temperature, 0.01 C two's-complement) and humidity
// (air.relativeHumidity, 0.5 %); report 0x12 carries temperature, humidity
// (0.01 %) and illuminance. Threshold-alarm flags are categorical, surfaced as
// camelCase extras. Device-info (bytes[2] == 0x00), the illuminance-only report
// (bytes[2] == 0x02; this device has no light sensor), the sensor-enable/state
// snapshot (bytes[2] == 0x11) and config responses (fPort 7) carry no climate
// measurement and are reported as errors.

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

  var air = {};

  if (reportType === 0x01) {
    // Temperature/humidity report. bytes[5] bit0 set => T/H reading valid.
    if ((bytes[5] & 0x01) === 0x00) {
      return { errors: ['temperature/humidity sensor reported no measurement'] };
    }
    air.temperature = decodeTemperature(bytes[8], bytes[9]);
    air.relativeHumidity = round(bytes[10] * 0.5, 1);
  } else if (reportType === 0x12) {
    // Combined temperature/humidity/illuminance report with alarm flags.
    air.temperature = decodeTemperature(bytes[4], bytes[5]);
    air.relativeHumidity = round(((bytes[6] << 8) | bytes[7]) * 0.01, 2);
    air.lightIntensity = (bytes[8] << 8) | bytes[9];
    var flags12 = bytes[10];
    data.lowTemperatureAlarm = flags12 & 0x01 ? true : false;
    data.highTemperatureAlarm = flags12 >> 1 & 0x01 ? true : false;
    data.lowHumidityAlarm = flags12 >> 2 & 0x01 ? true : false;
    data.highHumidityAlarm = flags12 >> 3 & 0x01 ? true : false;
    data.lowIlluminanceAlarm = flags12 >> 4 & 0x01 ? true : false;
    data.highIlluminanceAlarm = flags12 >> 5 & 0x01 ? true : false;
  } else {
    // 0x02 illuminance-only report (no light sensor on this device), 0x11
    // sensor-enable/state snapshot and any other report type carry no climate
    // measurement.
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no measurement'] };
  }

  data.air = air;
  return { data: data };
}
