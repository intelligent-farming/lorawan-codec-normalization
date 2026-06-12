// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM319 (Indoor Air Quality Sensor,
// 9-in-1: temperature, humidity, PIR, light level, CO2, TVOC, pressure, HCHO,
// PM2.5, PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/am319.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping decisions:
//   0x03/0x67 temperature  int16 LE /10 °C        -> air.temperature
//   0x04/0x68 humidity      byte /2 %              -> air.relativeHumidity
//   0x05/0x00 PIR           status byte (1=trigger)-> action.motion.detected
//                                                     (+ .count: 1 trigger / 0 idle)
//   0x06/0xCB light level   byte (0-5 index)       -> air.lightLevel extra
//   0x07/0x7D CO2           uint16 LE ppm          -> air.co2
//   0x08/0x7D TVOC (IAQ)    uint16 LE /100         -> air.tvoc extra
//   0x08/0xE6 TVOC (µg/m³)  uint16 LE              -> air.tvoc extra
//   0x09/0x73 pressure      uint16 LE /10 hPa      -> air.pressure
//   0x0A/0x7D HCHO          uint16 LE /100 mg/m³   -> air.hcho extra
//   0x0B/0x7D PM2.5         uint16 LE µg/m³        -> air.pm25 extra
//   0x0C/0x7D PM10          uint16 LE µg/m³        -> air.pm10 extra
//   0x01/0x75 battery       byte %                 -> batteryPercent extra
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`.
// The AM319 light channel reports a discrete brightness LEVEL (index, not lux),
// so it is emitted as the camelCase extra `air.lightLevel` rather than forced
// into `air.lightIntensity` (which the vocabulary defines as illuminance in
// lux). TVOC/HCHO/PM2.5/PM10 have no vocabulary key and are camelCase extras
// (tvoc, hcho, pm25, pm10).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var hasAir = false;
  var hasMotion = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 % resolution
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // PIR: status byte (1 = trigger, 0 = idle)
      var pir = bytes[i + 2];
      motion.detected = pir === 1;
      motion.count = pir === 1 ? 1 : 0;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0xcb) {
      // LIGHT LEVEL: discrete brightness index (not lux)
      air.lightLevel = bytes[i + 2];
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x07 && type === 0x7d) {
      // CO2: uint16 LE ppm
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x7d) {
      // TVOC (IAQ index): uint16 LE, 0.01 resolution
      air.tvoc = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0xe6) {
      // TVOC (µg/m³): uint16 LE
      air.tvoc = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x09 && type === 0x73) {
      // PRESSURE: uint16 LE, 0.1 hPa resolution
      air.pressure = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0a && type === 0x7d) {
      // HCHO: uint16 LE, 0.01 mg/m³ resolution
      air.hcho = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0b && type === 0x7d) {
      // PM2.5: uint16 LE µg/m³
      air.pm25 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0c && type === 0x7d) {
      // PM10: uint16 LE µg/m³
      air.pm10 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasMotion) {
    if (!data.action) {
      data.action = {};
    }
    data.action.motion = motion;
  }

  return { data: data };
}
