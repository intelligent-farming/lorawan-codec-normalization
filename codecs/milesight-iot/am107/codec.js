// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM107 (Ambience Monitoring Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/am107.js, attributed in NOTICE).
//
// Channels: 0x01/0x75 battery (PERCENTAGE -> batteryPercent extra; vocabulary
// `battery` is volts), 0x03/0x67 temperature (int16 /10 °C -> air.temperature),
// 0x04/0x68 humidity (byte /2 % -> air.relativeHumidity), 0x05/0x6A PIR
// activity count (uint16 -> action.motion.count), 0x06/0x65 light: illuminance
// (uint16 lux -> air.lightIntensity) plus infrared+visible and infrared raw
// counts (no vocabulary key -> camelCase extras infraredAndVisible, infrared),
// 0x07/0x7D CO2 (uint16 ppm -> air.co2), 0x08/0x7D TVOC (uint16, no vocabulary
// key -> camelCase extra tvoc), 0x09/0x73 pressure (uint16 /10 hPa ->
// air.pressure).

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
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x6a) {
      motion.count = u16le(bytes[i + 2], bytes[i + 3]);
      hasMotion = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x06 && type === 0x65) {
      air.lightIntensity = u16le(bytes[i + 2], bytes[i + 3]);
      air.infraredAndVisible = u16le(bytes[i + 4], bytes[i + 5]);
      air.infrared = u16le(bytes[i + 6], bytes[i + 7]);
      hasAir = true;
      i += 8;
      recognized = true;
    } else if (channel === 0x07 && type === 0x7d) {
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x7d) {
      air.tvoc = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x09 && type === 0x73) {
      air.pressure = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
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
