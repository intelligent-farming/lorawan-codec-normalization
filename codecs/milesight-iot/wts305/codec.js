// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight WTS305 / WTS506 (Weather Station:
// temperature, humidity, barometric pressure, wind speed/direction, rainfall).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/wts305.js, "Copyright 2023 Milesight IoT", attributed in
// NOTICE). Ported from that upstream decodeUplink/milesight decoder; author the
// normalization here — do NOT copy upstream normalizeUplink.
//
// Channel/type mapping (upstream is the source of truth for the wire format):
//   0x01/0x75 battery        byte %                 -> batteryPercent (extra)
//   0x03/0x67 temperature    int16 LE /10 °C        -> air.temperature
//   0x04/0x68 humidity       byte /2 %              -> air.relativeHumidity
//   0x05/0x84 wind direction int16 LE /10 °         -> wind.direction
//   0x06/0x73 pressure       uint16 LE /10 hPa      -> air.pressure (atmospheric)
//   0x07/0x92 wind speed     uint16 LE /10 m/s      -> wind.speed
//   0x08/0x77 rainfall total uint16 LE /100 mm      -> rain.cumulative
//             rainfall counter byte (0-255)         -> rainfallCounter (extra)
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. Barometric pressure is already
// reported in hPa (atmospheric pressure), so it maps directly to `air.pressure`.
// The rainfall frame counter has no vocabulary key and is emitted as the
// camelCase extra `rainfallCounter`.

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
  var wind = {};
  var rain = {};
  var hasAir = false;
  var hasWind = false;
  var hasRain = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY: percentage
      data.batteryPercent = bytes[i + 2];
      i += 3;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 % resolution
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      hasAir = true;
      i += 3;
    } else if (channel === 0x05 && type === 0x84) {
      // WIND DIRECTION: int16 LE, 0.1 ° resolution
      wind.direction = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasWind = true;
      i += 4;
    } else if (channel === 0x06 && type === 0x73) {
      // BAROMETRIC PRESSURE: uint16 LE, 0.1 hPa resolution (atmospheric)
      air.pressure = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
    } else if (channel === 0x07 && type === 0x92) {
      // WIND SPEED: uint16 LE, 0.1 m/s resolution
      wind.speed = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasWind = true;
      i += 4;
    } else if (channel === 0x08 && type === 0x77) {
      // RAINFALL: uint16 LE total mm (0.01 resolution) + 1-byte frame counter
      rain.cumulative = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      data.rainfallCounter = bytes[i + 4];
      hasRain = true;
      i += 5;
    } else {
      return {
        errors: [
          'unrecognized Milesight channel 0x' + channel.toString(16) +
            ' type 0x' + type.toString(16)
        ]
      };
    }
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasWind) {
    data.wind = wind;
  }
  if (hasRain) {
    data.rain = rain;
  }

  return { data: data };
}
