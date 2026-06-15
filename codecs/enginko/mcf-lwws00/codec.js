// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LWWS00 (LoRaWAN Weather
// Station: barometric pressure, air temperature, humidity, wind speed and
// direction, rainfall rate / daily total, solar radiation, UV). Enginko is the
// MCF88 rebrand; this is the same device family as enginko/mcf-lw12co2.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 "report data" weather frame) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-weather.js, attributed in NOTICE). We author the
// normalization here; the upstream parseWeather / TTNto helpers are not reused.
//
// Ported from upstream parseReportData -> parseWeather (uplinkId 0x0B, type
// '2', subtype '00'). The upstream Davis-style weather frame is laid out (after
// a 3-byte header [0x0B, type/subtype byte, subtype byte] and 2 leading
// reserved data bytes) as little-endian fields:
//   pressure(2, x1000 inHg) temperature(2, x10 degF) windSpeed(1, mph)
//   tenMinAvgWindSpeed(1, mph) windDirection(2, deg) humidity(1, %)
//   rainRate(2, x0.2 mm/h) uv(1) solarRadiation(2, W/m2) dayRain(2, x0.2 mm)
//   dayET(2) soilMoisture(4) leafWetness(4) forecastIcons(1) barTrend(1)
//
// Unit normalization to the vocabulary:
//   pressure: inHg (raw/1000) -> hPa via x33.863886666667; vocabulary air.pressure is hPa.
//   temperature: degF (raw/10) -> degC via (F-32)/1.8.
//   windSpeed: mph -> m/s via x0.44704.
//   rainRate / dayRain: raw counts x0.2 mm.
// Solar radiation (W/m2) and UV index have no vocabulary key, so they are
// emitted as the camelCase extras `solarRadiation` and `uvIndex`. The weather
// frame carries no battery reading, so neither `battery` nor `batteryPercent`
// is emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var uplinkId = bytes[0];
  if (uplinkId !== 0x0b) {
    return { errors: ['unsupported uplink id 0x' + uplinkId.toString(16)] };
  }

  // Report-data frame: byte1 high nibble is the report type, byte2 is the
  // subtype. The weather frame is type '2', subtype 0x00.
  if (bytes.length < 3) {
    return { errors: ['payload too short: truncated report header'] };
  }
  var reportType = (bytes[1] >> 4) & 0x0f;
  var subType = bytes[2];
  if (reportType !== 0x2 || subType !== 0x00) {
    return {
      errors: [
        'unsupported report frame type ' +
          reportType +
          ' subtype 0x' +
          subType.toString(16)
      ]
    };
  }

  // Data region begins after the 3-byte header. Upstream then skips 2 reserved
  // bytes before the first field; b is indexed relative to the data region.
  var d = 3;
  var b = [];
  var i;
  for (i = d; i < bytes.length; i++) {
    b.push(bytes[i]);
  }

  // Need through barTrend at b[29] for a complete weather frame.
  if (b.length < 30) {
    return { errors: ['payload too short: truncated weather frame'] };
  }

  var air = {};
  // Atmospheric pressure: inHg(raw/1000) -> hPa.
  air.pressure = round((u16le(b[2], b[3]) / 1000.0) * 33.863886666667, 2);
  // Air temperature: degF(raw/10) -> degC. Upstream reads this field unsigned
  // (no sign extension); ported faithfully.
  air.temperature = round((u16le(b[4], b[5]) / 10.0 - 32) / 1.8, 2);
  // Relative humidity (%).
  air.relativeHumidity = b[10] & 0xff;

  var wind = {};
  // Wind speed: mph -> m/s.
  wind.speed = round((b[6] & 0xff) * 0.44704, 2);
  // Wind direction: degrees (0..<360). Upstream emits the raw value; only emit
  // it when it satisfies the vocabulary bound.
  var direction = u16le(b[8], b[9]);
  if (direction < 360) {
    wind.direction = direction;
  }

  var rain = {};
  // Rainfall intensity (mm/hour) and daily cumulative rainfall (mm), raw x0.2.
  rain.intensity = round(u16le(b[11], b[12]) * 0.2, 2);
  rain.cumulative = round(u16le(b[16], b[17]) * 0.2, 2);

  var data = {};
  data.air = air;
  data.wind = wind;
  data.rain = rain;

  // Solar radiation (W/m2) and UV index: no vocabulary key -> camelCase extras.
  data.solarRadiation = u16le(b[14], b[15]);
  data.uvIndex = b[13] & 0xff;

  return { data: data };
}
