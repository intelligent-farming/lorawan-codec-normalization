// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R31504 / R315 (Wireless Temperature /
// Humidity / PIR / Emergency Button / Reed Switch / Seat Occupancy Sensor),
// data reports on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r315.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 is a multiplexed report keyed on byte 2 (byte 0 = protocol version,
// byte 1 = device type 0xD2 "R315", byte 2 = report type):
//   0x00  device-info/version frame (no measurement) -> errors
//   0x01  temperature + humidity report
//           - byte 3: battery voltage in 0.1 V; high bit = low-battery flag
//           - (byte 5 & 0x01) gates T/H validity (0 => sensor read invalid)
//           - bytes 8-9: temperature, signed 16-bit BE, 0.01 degC/count
//           - byte 10:   relative humidity, 0.5 %/count
//   0x02  illuminance-only report; the R31504 carries no light sensor, so this
//         report holds no climate measurement -> errors
//   0x11  function-enable / binary-sensor-state bitmap (config/state, no
//         measurement) -> errors
//   0x12  combined temperature + humidity (+ illuminance) report
//           - bytes 4-5: temperature, signed 16-bit BE, 0.01 degC/count
//           - bytes 6-7: relative humidity, 16-bit BE, 0.01 %/count
//           - byte 10:   threshold-alarm status bits
// fPort 7 carries configuration command responses (no measurement) -> errors.
//
// Battery is volts (the high bit of the voltage byte is the low-battery flag,
// surfaced as the camelCase extra `lowBattery`). Temperature -> air.temperature,
// humidity -> air.relativeHumidity. The R31504 has no light sensor, so the
// illuminance field carried in report 0x12 (and the illuminance-only 0x02
// report) is not emitted. Threshold-alarm bits the vocabulary does not model
// are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Signed 16-bit big-endian (two's complement) from bytes hi, lo.
function s16be(hi, lo) {
  var v = (hi << 8) | lo;
  if (v & 0x8000) {
    v = v - 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['configuration command response on fPort 7 (no measurement)'] };
  }
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
  if (reportType === 0x02) {
    return { errors: ['illuminance-only report 0x02 (no climate measurement)'] };
  }
  if (reportType === 0x11) {
    return { errors: ['function-enable / binary-sensor-state frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  if (reportType === 0x01) {
    // Temperature + humidity. (byte5 & 0x01) == 0 => the T/H read is invalid.
    if ((bytes[5] & 0x01) === 0x00) {
      return { errors: ['temperature/humidity sensor read invalid (no measurement)'] };
    }
    data.air = {
      temperature: round(s16be(bytes[8], bytes[9]) / 100, 2),
      relativeHumidity: round(bytes[10] * 0.5, 1)
    };
    return { data: data };
  }

  if (reportType === 0x12) {
    // Combined report. Temperature (bytes 4-5) + humidity (bytes 6-7); byte 10
    // carries threshold-alarm bits. The illuminance field (bytes 8-9) is not
    // emitted because the R31504 has no light sensor.
    data.air = {
      temperature: round(s16be(bytes[4], bytes[5]) / 100, 2),
      relativeHumidity: round(((bytes[6] << 8) | bytes[7]) * 0.01, 2)
    };
    var alarms = bytes[10];
    data.lowTemperatureAlarm = (alarms & 0x01) ? true : false;
    data.highTemperatureAlarm = ((alarms >> 1) & 0x01) ? true : false;
    data.lowHumidityAlarm = ((alarms >> 2) & 0x01) ? true : false;
    data.highHumidityAlarm = ((alarms >> 3) & 0x01) ? true : false;
    data.lowIlluminanceAlarm = ((alarms >> 4) & 0x01) ? true : false;
    data.highIlluminanceAlarm = ((alarms >> 5) & 0x01) ? true : false;
    return { data: data };
  }

  return { errors: ['unknown report type 0x' + reportType.toString(16) + ' (no measurement)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r31504";
  }
  return result;
}
