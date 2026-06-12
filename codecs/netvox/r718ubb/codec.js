// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718UBB (Wireless Multifunctional
// Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718ub.js, attributed
// in NOTICE). The data byte at bytes[2] selects the report variant:
//   0x00 -> device-info/version frame (no measurement)
//   0x01 -> temperature (16-bit BE, two's complement, /100) -> air.temperature;
//           humidity (16-bit BE, /100) -> air.relativeHumidity; CO2 (16-bit BE,
//           ppm) -> air.co2; shock-event counter -> camelCase extra `shockEvent`
//   0x02 -> air pressure (32-bit BE, /100 hPa) -> air.pressure; illuminance
//           (24-bit BE, lux) -> air.lightIntensity
//   0x03 -> particulate/TVOC report; the vocabulary models none of these, so
//           PM2.5/PM10/TVOC become the camelCase extras `pm2_5`/`pm10`/`tvoc`
// Battery is volts (high bit of the voltage byte is the low-battery flag,
// surfaced as the camelCase extra `lowBattery`). Device-info frames (bytes[2]
// == 0) and config/command frames (fPort 7) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
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

  if (reportType === 0x01) {
    // Bytes 4-5: temperature (°C), 16-bit big-endian, two's complement, /100.
    var rawTemp = (bytes[4] << 8) | bytes[5];
    if (rawTemp & 0x8000) {
      rawTemp = rawTemp - 0x10000;
    }
    data.air = {
      temperature: round(rawTemp / 100, 2),
      relativeHumidity: round(((bytes[6] << 8) | bytes[7]) / 100, 2),
      co2: (bytes[8] << 8) | bytes[9]
    };
    // Byte 10: shock-event counter (vendor diagnostic; not a vocabulary key).
    data.shockEvent = bytes[10];
    return { data: data };
  }

  if (reportType === 0x02) {
    // Bytes 4-7: air pressure (hPa), 32-bit big-endian, /100.
    var rawPressure = (bytes[4] * 16777216) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];
    // Bytes 8-10: illuminance (lux), 24-bit big-endian, unsigned.
    var lux = (bytes[8] << 16) | (bytes[9] << 8) | bytes[10];
    data.air = {
      pressure: round(rawPressure / 100, 2),
      lightIntensity: lux
    };
    return { data: data };
  }

  if (reportType === 0x03) {
    // Bytes 4-9: PM2.5, PM10, TVOC. The vocabulary models none of these, so
    // they are emitted as camelCase extras.
    data.pm2_5 = (bytes[4] << 8) | bytes[5];
    data.pm10 = (bytes[6] << 8) | bytes[7];
    data.tvoc = (bytes[8] << 8) | bytes[9];
    return { data: data };
  }

  return { errors: ['unknown report type 0x' + reportType.toString(16) + ' (no measurement)'] };
}
