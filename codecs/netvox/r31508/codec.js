// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R31508 (R315 - Wireless Temperature /
// Humidity / PIR / Tilt / Dry Contact Input / Digital Output Sensor), data
// report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r315.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink. The R315-family wire format is shared with the r31502
// codec in this repo.
//
// fPort 6 carries periodic data reports; bytes[0]=version, bytes[1]=deviceType,
// bytes[2]=reportType. Battery is volts (bytes[3] in 0.1 V; high bit of
// bytes[3] is the low-battery flag, surfaced as the camelCase extra
// `lowBattery`). Report 0x01 carries temperature (air.temperature, 0.01 C
// two's-complement) and humidity (air.relativeHumidity, 0.5 %) when the T/H
// sensor reports a valid reading (bytes[5] bit0 set). Report 0x02 carries
// illuminance (air.lightIntensity, lux) with threshold-alarm flags. Report
// 0x12 carries temperature, humidity (0.01 %) and illuminance with alarm flags.
// Threshold-alarm flags are categorical, surfaced as camelCase extras.
// Device-info (reportType 0x00), the sensor-enable/state snapshot
// (reportType 0x11) and config responses (fPort 7) carry no measurement and
// are reported as errors.

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
  } else if (reportType === 0x02) {
    // Illuminance report with threshold-alarm flags.
    air.lightIntensity = (bytes[4] << 8) | bytes[5];
    var flags2 = bytes[6];
    data.lowTemperatureAlarm = flags2 & 0x01 ? true : false;
    data.highTemperatureAlarm = flags2 >> 1 & 0x01 ? true : false;
    data.lowHumidityAlarm = flags2 >> 2 & 0x01 ? true : false;
    data.highHumidityAlarm = flags2 >> 3 & 0x01 ? true : false;
    data.lowIlluminanceAlarm = flags2 >> 4 & 0x01 ? true : false;
    data.highIlluminanceAlarm = flags2 >> 5 & 0x01 ? true : false;
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
    // 0x11 sensor-enable/state snapshot and any other report type carry only
    // categorical bitmaps, not a measurement.
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no measurement'] };
  }

  data.air = air;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r31508";
  }
  return result;
}
