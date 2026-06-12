// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM104 (Indoor Air Quality Sensor,
// 4-in-1: temperature, humidity, PIR activity, light).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/am104.js, attributed in NOTICE).
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. The PIR channel (0x05/0x6A)
// reports an activity event count -> action.motion.count, with
// action.motion.detected derived as count > 0. The light channel (0x06/0x65)
// carries lux (illumination) plus two raw spectral counts
// (infrared_and_visible, infrared) that have no vocabulary key, so those are
// emitted as camelCase extras.

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
  var data = {};
  var air = {};
  var motion = {};
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
      // TEMPERATURE: int16 LE, 0.1 degC resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 % resolution
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x6a) {
      // PIR: uint16 LE activity event count
      var count = u16le(bytes[i + 2], bytes[i + 3]);
      motion.count = count;
      motion.detected = count > 0;
      i += 4;
      recognized = true;
    } else if (channel === 0x06 && type === 0x65) {
      // LIGHT: illumination (lux) + raw spectral counts
      air.lightIntensity = u16le(bytes[i + 2], bytes[i + 3]);
      data.infraredAndVisible = u16le(bytes[i + 4], bytes[i + 5]);
      data.infrared = u16le(bytes[i + 6], bytes[i + 7]);
      i += 8;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }
  if (air.temperature !== undefined ||
      air.relativeHumidity !== undefined ||
      air.lightIntensity !== undefined) {
    data.air = air;
  }
  if (motion.count !== undefined) {
    data.action = { motion: motion };
  }
  return { data: data };
}
