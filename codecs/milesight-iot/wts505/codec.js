// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight WTS505 (Weather Station: temperature,
// humidity, barometric pressure, wind speed, wind direction; optional rainfall).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to, and the
// decode loop ported from, the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/milesight-iot/wts505.js, attributed
// in NOTICE). The upstream wts305.js / wts505.js / wts506.js decoders are byte
// identical. Author the normalization here; do NOT copy upstream normalizeUplink.
//
// Channel/type map (ported from upstream milesight()):
//   0x01/0x75 battery       byte %                 -> batteryPercent extra
//   0x03/0x67 temperature   int16 LE /10 °C        -> air.temperature
//   0x04/0x68 humidity      byte /2 %              -> air.relativeHumidity
//   0x05/0x84 wind direction int16 LE /10 °        -> wind.direction
//   0x06/0x73 pressure      uint16 LE /10 hPa      -> air.pressure (atmospheric)
//   0x07/0x92 wind speed    uint16 LE /10 m/s      -> wind.speed
//   0x08/0x77 rainfall_total uint16 LE /100 mm     -> rain.cumulative
//             + frame counter byte                 -> rainfallCounter extra
//
// Mapping decisions:
//   Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
//   volts, so the percentage is emitted as the camelCase extra `batteryPercent`
//   rather than being forced into a volts field.
//   `air.pressure` is atmospheric/barometric pressure in hPa (vocabulary unit),
//   so the upstream value (already hPa after /10) maps directly with no scaling.
//   The rainfall frame counter is a vendor diagnostic with no vocabulary key, so
//   it is emitted as the camelCase extra `rainfallCounter`.

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
  var wind = {};
  var rain = {};
  var hasAir = false;
  var hasWind = false;
  var hasRain = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY: 1 byte percentage
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
    } else if (channel === 0x05 && type === 0x84) {
      // WIND DIRECTION: int16 LE, 0.1 ° resolution
      wind.direction = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasWind = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x06 && type === 0x73) {
      // BAROMETRIC (ATMOSPHERIC) PRESSURE: uint16 LE, 0.1 hPa resolution
      air.pressure = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x07 && type === 0x92) {
      // WIND SPEED: uint16 LE, 0.1 m/s resolution
      wind.speed = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasWind = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x77) {
      // RAINFALL: cumulative total uint16 LE, 0.01 mm resolution, plus a frame
      // counter byte that increments each upload (new-accumulation marker).
      rain.cumulative = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      data.rainfallCounter = bytes[i + 4];
      hasRain = true;
      i += 5;
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
  if (hasWind) {
    data.wind = wind;
  }
  if (hasRain) {
    data.rain = rain;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "wts505";
  }
  return result;
}
