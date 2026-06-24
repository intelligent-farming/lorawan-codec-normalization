// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM308 (Indoor Air Quality Sensor,
// 7-in-1: temperature, humidity, PIR activity, light, CO2, TVOC, barometric
// pressure, PM2.5, PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/am308.js, attributed in NOTICE).
//
// Channels: 0x01/0x75 battery (PERCENTAGE -> batteryPercent extra; vocabulary
// `battery` is volts, never a percentage), 0x03/0x67 temperature (int16 /10 °C
// -> air.temperature), 0x04/0x68 humidity (byte /2 % -> air.relativeHumidity),
// 0x05/0x6A PIR activity count (uint16 -> action.motion.count, with
// action.motion.detected derived as count > 0; the shipped TTN examples use
// this AM107-style activity-count form rather than the upstream datasheet's
// 0x05/0x00 trigger/idle byte, which is also accepted below), 0x06/0xCB light
// level (byte 0-6 ambient-light index, NOT lux -> camelCase extra lightLevel;
// it is not air.lightIntensity, whose unit is lux), 0x07/0x7D CO2 (uint16 ppm
// -> air.co2), 0x08/0x7D TVOC IAQ (uint16 /100 -> camelCase extra tvoc; no
// vocabulary key), 0x09/0x73 pressure (uint16 /10 hPa -> air.pressure),
// 0x0A/0x7D HCHO (uint16 /100 mg/m3 -> camelCase extra hcho), 0x0B/0x7D PM2.5
// (uint16 µg/m3 -> camelCase extra pm2_5), 0x0C/0x7D PM10 (uint16 µg/m3 ->
// camelCase extra pm10), 0x0D/0x7D O3 (uint16 /100 ppm -> camelCase extra o3),
// 0x0E/0x01 buzzer/beep (byte -> camelCase extra beep boolean).

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

function decodeUplinkCore(input) {
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
      // BATTERY: percentage (vocabulary `battery` is volts -> extra)
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
    } else if (channel === 0x05 && type === 0x6a) {
      // PIR: uint16 LE activity event count (TTN example form)
      var count = u16le(bytes[i + 2], bytes[i + 3]);
      motion.count = count;
      motion.detected = count > 0;
      hasMotion = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // PIR: 1 byte trigger/idle (datasheet form)
      var triggered = bytes[i + 2] === 1;
      motion.count = triggered ? 1 : 0;
      motion.detected = triggered;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0xcb) {
      // LIGHT LEVEL: 1 byte ambient-light index (0-6), not lux -> extra
      data.lightLevel = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x07 && type === 0x7d) {
      // CO2: uint16 LE ppm
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x7d) {
      // TVOC (IAQ): uint16 LE / 100 -> extra (no vocabulary key)
      data.tvoc = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0xe6) {
      // TVOC (µg/m3): uint16 LE -> extra
      data.tvoc = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x09 && type === 0x73) {
      // PRESSURE: uint16 LE, 0.1 hPa resolution
      air.pressure = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0a && type === 0x7d) {
      // HCHO: uint16 LE / 100 mg/m3 -> extra
      data.hcho = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x0b && type === 0x7d) {
      // PM2.5: uint16 LE µg/m3 -> extra
      data.pm2_5 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x0c && type === 0x7d) {
      // PM10: uint16 LE µg/m3 -> extra
      data.pm10 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x0d && type === 0x7d) {
      // O3: uint16 LE / 100 ppm -> extra
      data.o3 = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x0e && type === 0x01) {
      // BEEP / buzzer: 1 byte -> extra boolean
      data.beep = bytes[i + 2] === 1;
      i += 3;
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "am308";
  }
  return result;
}
