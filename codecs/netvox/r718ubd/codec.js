// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718UBD (R718UB Series - Wireless
// Multifunctional CO2 Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718ub.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports; bytes[0] is the frame version,
// bytes[1] the device type (0xBB == R718UB Series) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement.
//
// For a measurement frame, bytes[3] is battery voltage in 0.1 V (high bit
// flags low battery, surfaced as the camelCase extra `lowBattery`).
//
//   reportType 0x01 -> Temperature (bytes[4..5], 0.01 C two's-complement) ->
//                      air.temperature; Humidity (bytes[6..7], 0.01 %) ->
//                      air.relativeHumidity; CO2 (bytes[8..9], ppm) -> air.co2;
//                      ShockEvent (bytes[10]) -> camelCase extra `shockEvent`.
//
// The R718UB series shares one upstream decoder across modular variants; report
// types 0x02 (air pressure / illuminance) and 0x03 (PM2.5 / PM10 / TVOC) belong
// to other variants in that series, not the R718UBD CO2 sensor, and are
// reported as errors. Config responses (fPort 7) carry no measurement and are
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

  if (reportType !== 0x01) {
    // 0x02 (air pressure / illuminance) and 0x03 (PM2.5 / PM10 / TVOC) belong
    // to other R718UB-series variants, not this CO2 sensor.
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no CO2/climate measurement for this device'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // reportType 0x01: Temperature / Humidity / CO2 / ShockEvent.
  var air = {};
  air.temperature = decodeTemperature(bytes[4], bytes[5]);
  air.relativeHumidity = round(((bytes[6] << 8) | bytes[7]) / 100, 2);
  air.co2 = (bytes[8] << 8) | bytes[9];
  data.shockEvent = bytes[10];

  data.air = air;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718ubd";
  }
  return result;
}
