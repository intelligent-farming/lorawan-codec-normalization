// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM103L (Indoor Ambience Monitoring
// Sensor, 3-in-1: temperature, humidity, CO2).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/am103l.js — a shared AM104/AM107 decoder, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping decisions (channels present in the shared upstream decoder; the AM103L
// only physically ships temperature/humidity/CO2 + battery, but the full TLV
// set is ported faithfully so any firmware variant decodes cleanly):
//   0x01/0x75 battery       byte %                 -> batteryPercent extra
//   0x03/0x67 temperature   int16 LE /10 °C        -> air.temperature
//   0x04/0x68 humidity      byte /2 %              -> air.relativeHumidity
//   0x05/0x6A PIR activity   uint16 LE count        -> activity extra
//   0x06/0x65 light          uint16 LE lux + 2x ir  -> air.lightIntensity (lux),
//                                                      infraredAndVisible /
//                                                      infrared extras
//   0x07/0x7D CO2           uint16 LE ppm          -> air.co2
//   0x08/0x7D TVOC          uint16 LE              -> air.tvoc extra
//   0x09/0x73 pressure      uint16 LE /10 hPa      -> air.pressure
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. The light channel reports
// illuminance in lux, so it maps to the vocabulary key `air.lightIntensity`;
// its companion raw IR counters, the PIR activity counter, and TVOC have no
// vocabulary key and are camelCase extras.

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
  var hasAir = false;
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
      // PIR ACTIVITY: uint16 LE event count
      data.activity = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x06 && type === 0x65) {
      // LIGHT: illuminance (lux) + raw IR/visible counters
      air.lightIntensity = u16le(bytes[i + 2], bytes[i + 3]);
      data.infraredAndVisible = u16le(bytes[i + 4], bytes[i + 5]);
      data.infrared = u16le(bytes[i + 6], bytes[i + 7]);
      hasAir = true;
      i += 8;
      recognized = true;
    } else if (channel === 0x07 && type === 0x7d) {
      // CO2: uint16 LE ppm
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x7d) {
      // TVOC: uint16 LE (no vocabulary key -> extra)
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

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "am103l";
  }
  return result;
}
