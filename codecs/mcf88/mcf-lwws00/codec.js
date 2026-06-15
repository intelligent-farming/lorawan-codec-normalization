// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCF88 / Enginko MCF-LWWS00 (LoRaWAN Weather
// Station: barometric pressure, air temperature/humidity, wind speed and
// direction, rainfall rate and daily total, solar radiation and UV).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCF88 "report data" uplink 0x0B, sub-type 2 / 0x00 = weather) ported
// from the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcf88/decoder-weather.js, attributed in NOTICE). We author the
// normalization here; the upstream string-formatting helpers and TTN
// array-of-{variable,value} output shape are not reused.
//
// The underlying sensor is a Davis-style weather station, so the raw values use
// imperial units: barometric pressure in inHg (x1000), temperature in degF
// (x10), wind speed in mph, rain in 0.2 mm "clicks". They are converted to the
// vocabulary units (hPa, degC, m/s, mm) here. Pressure is barometric (sea-level
// adjusted) and lands in the atmospheric 900..1100 hPa band.
//
// Mapping to the normalized vocabulary:
//   barometric pressure   -> air.pressure (hPa)
//   outside temperature   -> air.temperature (degC)
//   outside humidity      -> air.relativeHumidity (%)
//   wind speed            -> wind.speed (m/s)
//   wind direction        -> wind.direction (deg, 0..<360; raw 360 -> 0)
//   rain rate             -> rain.intensity (mm/h)
//   day rain (cumulative) -> rain.cumulative (mm)
// Readings the vocabulary does not model are emitted as camelCase extras:
//   solar radiation (W/m2) -> solarRadiation
//   UV index               -> uvIndex
//   10-minute avg wind     -> windSpeedTenMinuteAvg (m/s)
//   day evapotranspiration -> dayEvapotranspiration (mm)
// This weather frame carries no battery field, so no battery/batteryPercent is
// emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(bytes, i) {
  return bytes[i] & 0xff;
}

function u16le(bytes, i) {
  return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
}

function mphToMs(mph) {
  return mph * 0.44704;
}

function fahrenheitToCelsius(f) {
  return (f - 32) / 1.8;
}

// inHg (already divided by 1000 upstream) -> hPa.
function inHgToHpa(inHg) {
  return inHg * 33.863886666667;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var id = bytes[0];
  if (id !== 0x0b) {
    return { errors: ['unsupported frame id 0x' + id.toString(16)] };
  }

  // bytes[1] high nibble = report sub-type, bytes[2] = report kind.
  var subType = (bytes[1] >> 4) & 0x0f;
  var kind = bytes[2];
  if (subType !== 2 || kind !== 0x00) {
    return {
      errors: [
        'unsupported report 0x' +
          bytes[1].toString(16) +
          ' / 0x' +
          kind.toString(16) +
          ': not a weather frame'
      ]
    };
  }

  // Upstream drops the 3-byte header (0x0B, sub-type, kind) then indexes the
  // remaining payload. The weather body needs 30 bytes (indices 0..29), so the
  // full frame is 3 + 30 = 33 bytes.
  var w = bytes.slice(3);
  if (w.length < 30) {
    return { errors: ['payload too short: weather frame needs 33 bytes'] };
  }

  var data = {};
  var air = {};
  var wind = {};
  var rain = {};

  // Barometric pressure: 16-bit LE, inHg x1000.
  air.pressure = round(inHgToHpa(u16le(w, 2) / 1000.0), 2);

  // Outside temperature: 16-bit LE, degF x10.
  air.temperature = round(fahrenheitToCelsius(u16le(w, 4) / 10.0), 2);

  // Outside humidity: 1 byte, percent.
  air.relativeHumidity = u8(w, 10);

  // Wind speed: 1 byte, mph -> m/s.
  wind.speed = round(mphToMs(u8(w, 6)), 2);

  // Wind direction: 16-bit LE, degrees. Davis reports 360 for North; the
  // vocabulary requires 0 <= direction < 360, so wrap 360 -> 0.
  wind.direction = u16le(w, 8) % 360;

  // Rain rate: 16-bit LE, 0.2 mm clicks -> mm/h.
  rain.intensity = round(u16le(w, 11) * 0.2, 2);

  // Day rain (cumulative): 16-bit LE, 0.2 mm clicks -> mm.
  rain.cumulative = round(u16le(w, 16) * 0.2, 2);

  data.air = air;
  data.wind = wind;
  data.rain = rain;

  // Extras (no vocabulary key).
  data.windSpeedTenMinuteAvg = round(mphToMs(u8(w, 7)), 2);
  data.uvIndex = u8(w, 13);
  data.solarRadiation = u16le(w, 14);
  // Day evapotranspiration: 16-bit LE, in thousandths of an inch -> mm.
  data.dayEvapotranspiration = round((u16le(w, 18) / 1000.0) * 25.4, 2);

  return { data: data };
}
