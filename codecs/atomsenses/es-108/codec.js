// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for AtomSenses ES-108 (11-in-1 indoor air-quality
// modular combo: battery, temperature, humidity, and a suite of gas / PM
// channels).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight-style channel/type TLV) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/atomsenses/es-108.js, attributed in NOTICE). Author the normalization
// here; do NOT copy upstream normalizeUplink.
//
// Ported from the upstream Decoder() faithfully (channel ids, types, byte
// widths and little-endian readers preserved exactly):
//   0x01/0x75 battery       byte %             -> batteryPercent extra
//   0x03/0x67 temperature   int16 LE /10 °C    -> air.temperature
//   0x04/0x68 humidity      byte /2 %          -> air.relativeHumidity
//   0x05/0x70 NO2           byte               -> air.no2 extra
//   0x06/0x7D TVOC          uint16 LE          -> air.tvoc extra
//   0x07/0x7D CO2           uint16 LE ppm      -> air.co2
//   0x08/0x7D NH3           uint16 LE /100     -> air.nh3 extra
//   0x09/0x7D H2S           uint16 LE /100     -> air.h2s extra
//   0x0A/0x7D HCHO          uint16 LE /100     -> air.hcho extra
//   0x0B/0x7D PM2.5         uint16 LE          -> air.pm2_5 extra
//   0x0C/0x7D PM10          uint16 LE          -> air.pm10 extra
//   0x0D/0x7D O3            uint16 LE /100     -> air.o3 extra
//
// AtomSenses reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. Only temperature, humidity and
// CO2 have vocabulary keys; every other gas / particulate value has no
// vocabulary key and is emitted as a camelCase extra under `air` (PM2.5 becomes
// `pm2_5` so the key stays a legal identifier).

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
    } else if (channel === 0x05 && type === 0x70) {
      // NO2: 1 byte (no vocabulary key -> extra)
      air.no2 = bytes[i + 2];
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0x7d) {
      // TVOC: uint16 LE (no vocabulary key -> extra)
      air.tvoc = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x07 && type === 0x7d) {
      // CO2: uint16 LE ppm
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x7d) {
      // NH3: uint16 LE, 0.01 resolution (no vocabulary key -> extra)
      air.nh3 = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x09 && type === 0x7d) {
      // H2S: uint16 LE, 0.01 resolution (no vocabulary key -> extra)
      air.h2s = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0a && type === 0x7d) {
      // HCHO: uint16 LE, 0.01 resolution (no vocabulary key -> extra)
      air.hcho = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0b && type === 0x7d) {
      // PM2.5: uint16 LE (no vocabulary key -> extra)
      air.pm2_5 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0c && type === 0x7d) {
      // PM10: uint16 LE (no vocabulary key -> extra)
      air.pm10 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0d && type === 0x7d) {
      // O3: uint16 LE, 0.01 resolution (no vocabulary key -> extra)
      air.o3 = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      hasAir = true;
      i += 4;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized AtomSenses channels'] };
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
