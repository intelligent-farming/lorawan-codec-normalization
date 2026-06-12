// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM307 (Indoor Air Quality Sensor,
// 7-in-1: temperature, humidity, PIR, light, CO2, TVOC, barometric pressure).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/am307-codec.yaml, attributed in NOTICE).
//
// Channels: 0x01/0x75 battery (PERCENTAGE -> batteryPercent extra; vocabulary
// `battery` is volts), 0x03/0x67 temperature (int16 /10 °C -> air.temperature),
// 0x04/0x68 humidity (byte /2 % -> air.relativeHumidity), PIR ->
// action.motion (0x05/0x6A is an AM107-family uint16 activity count, which the
// AM307/AM319 wire payload uses in practice -> action.motion.count; 0x05/0x00 is
// a byte trigger/idle flag -> action.motion.count 1/0). The upstream decoder
// only handles 0x05/0x00 and silently drops the 0x05/0x6A count present in the
// TTN example, so we author the correct decode of both. 0x06/0x65 light:
// illuminance (uint16 lux -> air.lightIntensity) plus raw infrared+visible /
// infrared counts (no vocabulary key -> camelCase extras); 0x06/0xCB light_level
// (byte index, no vocabulary key -> camelCase extra lightLevel). 0x07/0x7D CO2
// (uint16 ppm -> air.co2), 0x08/0x7D TVOC (uint16, no vocabulary key ->
// camelCase extra tvoc), 0x09/0x73 pressure (uint16 /10 hPa -> air.pressure),
// 0x0A/0x7D HCHO (uint16 /100 -> hcho), 0x0B/0x7D PM2.5 (uint16 -> pm2_5),
// 0x0C/0x7D PM10 (uint16 -> pm10), 0x0D/0x7D O3 (uint16 /100 -> o3), 0x0E/0x01
// beep (byte -> beep boolean). HCHO/PM/O3/TVOC have no vocabulary key, so they
// are emitted as camelCase extras.

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
    } else if (channel === 0x05 && type === 0x6a) {
      // PIR: uint16 LE activity event count (AM107-family payload form)
      var count = u16le(bytes[i + 2], bytes[i + 3]);
      motion.count = count;
      motion.detected = count > 0;
      hasMotion = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // PIR: 1-byte trigger (1) / idle (0) flag
      var triggered = bytes[i + 2] === 1;
      motion.count = triggered ? 1 : 0;
      motion.detected = triggered;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0x65) {
      // LIGHT: illuminance (lux) + raw spectral counts
      air.lightIntensity = u16le(bytes[i + 2], bytes[i + 3]);
      data.infraredAndVisible = u16le(bytes[i + 4], bytes[i + 5]);
      data.infrared = u16le(bytes[i + 6], bytes[i + 7]);
      hasAir = true;
      i += 8;
      recognized = true;
    } else if (channel === 0x06 && type === 0xcb) {
      // LIGHT level index (no vocabulary key -> extra)
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
      // TVOC: uint16 LE (no vocabulary key -> extra)
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
      // HCHO: uint16 LE, 0.01 resolution (no vocabulary key -> extra)
      data.hcho = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x0b && type === 0x7d) {
      // PM2.5: uint16 LE ug/m3 (no vocabulary key -> extra)
      data.pm2_5 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x0c && type === 0x7d) {
      // PM10: uint16 LE ug/m3 (no vocabulary key -> extra)
      data.pm10 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x0d && type === 0x7d) {
      // O3: uint16 LE, 0.01 resolution (no vocabulary key -> extra)
      data.o3 = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x0e && type === 0x01) {
      // BEEP: 1-byte flag (no vocabulary key -> extra)
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
