// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCF88 / Enginko MCF-LWWS01 (LoRaWAN weather
// station front-end for a Davis Vantage console: barometric pressure, outside
// temperature/humidity, wind speed and direction, rain rate and daily rain,
// UV index, solar radiation, evapotranspiration, plus soil/leaf accessory
// channels).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcf88/decoder-weather.js, attributed
// in NOTICE) — the upstream "Report data / weather" (0x0B, type 2, sub 0x00)
// frame parser is the source of truth for the wire format and unit conversions.
// We author the normalization here; the upstream string-slicing helpers and the
// array-shaped TTN output are not reused.
//
// Same MCF88/Enginko "data frame" family as MCF-LW12CO2, but this frame is the
// Davis Vantage relay frame: an uplink id byte (0x0B), a frame-type nibble (2)
// with sub-type byte (0x00), then a fixed 30-byte little-endian weather record.
//
// Units from upstream (carried verbatim into the conversions below):
//   pressure: console reports inHg*1000; hPa = (raw / 1000) * 33.863886666667
//   temperature: outside temp degF*10; degC = ((degF) - 32) / 1.8  (no sign ext)
//   wind speed: mph; m/s = mph * 0.44704
//   wind direction: degrees, reported directly (0..359)
//   rain rate / daily rain: tip counts; mm = counts * 0.2
//   evapotranspiration: thousandths of an inch; mm = (raw / 1000) * 25.4
//   solar radiation: W/m2 reported directly; uv index reported directly.
//
// Solar radiation (W/m2) is NOT illuminance (lux) and is deliberately emitted as
// the camelCase extra `solarRadiation`, never air.lightIntensity. UV index is the
// extra `uvIndex`. This frame carries no battery field.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Uplink id 0x0B = "report data". The frame-type nibble lives in the high
  // nibble of byte 1; sub-type is byte 2. Weather is type 2, sub-type 0x00.
  if (bytes[0] !== 0x0b) {
    return { errors: ['Error on decoding payload'] };
  }
  var frameType = (bytes[1] >> 4) & 0x0f;
  var subType = bytes[2];
  if (frameType !== 2 || subType !== 0x00) {
    return { errors: ['Error on decoding payload'] };
  }

  // Upstream slices off the first 3 bytes, then indexes the 30-byte record.
  // d[i] below is bytes[i + 3].
  var base = 3;
  var need = base + 30;
  if (bytes.length < need) {
    return { errors: ['payload too short: weather record needs 30 bytes'] };
  }

  function d(i) {
    return bytes[base + i] & 0xff;
  }

  var data = {};
  var air = {};
  var wind = {};
  var rain = {};

  // Atmospheric pressure: console inHg*1000 (little-endian at d[2..3]).
  var inHgMilli = u16le(d(2), d(3)) / 1000.0;
  air.pressure = round(inHgMilli * 33.863886666667, 2);

  // Outside temperature: degF*10 (little-endian at d[4..5]). Upstream applies no
  // sign extension here, so this is unsigned by design — kept verbatim.
  var degF = u16le(d(4), d(5)) / 10.0;
  air.temperature = round((degF - 32) / 1.8, 2);

  // Outside humidity (%) at d[10].
  air.relativeHumidity = round(d(10), 2);

  data.air = air;

  // Wind speed (mph -> m/s) at d[6]; direction (degrees) little-endian at d[8..9].
  wind.speed = round(d(6) * 0.44704, 2);
  wind.direction = round(u16le(d(8), d(9)), 2);
  data.wind = wind;

  // Rain rate (tip counts -> mm/h) little-endian at d[11..12]; daily cumulative
  // rain (tip counts -> mm) little-endian at d[16..17].
  rain.intensity = round(u16le(d(11), d(12)) * 0.2, 2);
  rain.cumulative = round(u16le(d(16), d(17)) * 0.2, 2);
  data.rain = rain;

  // Extras the vocabulary does not model.
  // UV index (dimensionless) at d[13].
  data.uvIndex = round(d(13), 2);
  // Solar radiation (W/m2) little-endian at d[14..15] — NOT lux.
  data.solarRadiation = round(u16le(d(14), d(15)), 2);
  // 10-minute average wind speed (mph -> m/s) at d[7].
  data.windSpeedAvg10min = round(d(7) * 0.44704, 2);
  // Daily evapotranspiration (thousandths of inch -> mm) little-endian at d[18..19].
  data.dayEvapotranspiration = round(u16le(d(18), d(19)) / 1000.0 * 25.4, 2);
  // Forecast icon bitmask and barometric trend at d[28], d[29].
  data.forecastIcons = d(28);
  data.barTrend = d(29);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcf88";
    result.data.model = "mcf-lwws01";
  }
  return result;
}
