// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LWWS02 (Weather Station:
// air temperature, humidity, barometric pressure, wind speed/direction,
// rainfall, UV, solar radiation). The MCF-LWWS02 is a LoRaWAN bridge for a
// Davis Instruments Vantage Pro2 console, so the wire values arrive in the
// Davis units (inHg, Fahrenheit, mph, 0.2 mm rain clicks). Enginko is the
// MCF88 rebrand.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 "report data" frame 0x0B, sub-type 2, sub-sub 0x00:
// little-endian fields per the Davis weather record) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-weather.js -> parseWeather, attributed in NOTICE). We
// author the normalization here; the upstream string-building helpers and its
// `variable`/`unit` object array are not reused.
//
// Unit conversions match the upstream Davis math exactly:
//   pressure: rawInHg/1000 inHg -> hPa (x 33.863886666667) -> air.pressure
//   temperature: rawF/10 degF -> degC ((F - 32) / 1.8) -> air.temperature
//   wind speed: rawMph mph -> m/s (x 0.44704) -> wind.speed
//   wind direction: raw degrees -> wind.direction
//   rain rate: clicks x 0.2 mm -> mm/h -> rain.intensity
//   day rain: clicks x 0.2 mm -> mm -> rain.cumulative
//   humidity: raw % -> air.relativeHumidity
// Sensor readings the vocabulary does not model (UV index, solar radiation
// W/m2, 10-minute average wind speed, daily evapotranspiration, soil-moisture
// and leaf-wetness channels, Davis forecast icons / barometer trend) are
// emitted as camelCase extras. This frame carries no battery field.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

// Davis inHg-thousandths -> hPa, mirroring upstream getAtmosphericPressure.
function pressureHpa(rawThousandthsInHg) {
  return round((rawThousandthsInHg / 1000.0) * 33.863886666667, 2);
}

// Davis tenths-of-Fahrenheit -> Celsius, mirroring upstream
// getFahrenheitToCelsius (applied to value/10).
function fahrenheitTenthsToCelsius(rawTenthsF) {
  return round((rawTenthsF / 10.0 - 32) / 1.8, 2);
}

// Davis mph byte -> m/s, mirroring upstream getWindSpeed.
function windSpeedMs(rawMph) {
  return round(rawMph * 0.44704, 2);
}

// Davis 0.2 mm rain clicks -> mm, mirroring upstream getRainRate.
function rainMm(rawClicks) {
  return round(rawClicks * 0.2, 2);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Frame header: byte0 uplink id, byte1 sub-type (high nibble), byte2 sub-sub.
  var uplinkId = bytes[0];
  if (uplinkId !== 0x0b) {
    return { errors: ['unsupported uplink id 0x' + uplinkId.toString(16)] };
  }
  if (bytes.length < 3) {
    return { errors: ['payload too short: report-data header'] };
  }
  var subType = (bytes[1] >> 4) & 0x0f;
  var subSub = bytes[2];
  if (subType !== 2 || subSub !== 0x00) {
    return {
      errors: [
        'unsupported report-data frame: sub-type ' +
          subType +
          ', sub-sub 0x' +
          subSub.toString(16)
      ]
    };
  }

  // Weather record begins after the 3-byte header. Offsets below are relative
  // to the record start (= upstream's `payloadToByteArray.slice(3)` indices),
  // so add 3 to index into `bytes`. The record runs through barTrend (index
  // 29 -> byte 32 inclusive), so the frame must hold 33 bytes.
  var base = 3;
  if (bytes.length < base + 30) {
    return { errors: ['payload too short: truncated weather record'] };
  }

  function rec(i) {
    return bytes[base + i];
  }

  var data = {};
  var air = {};
  var wind = {};
  var rain = {};

  // Atmospheric (barometric) pressure: little-endian u16 at record bytes 2..3.
  air.pressure = pressureHpa(u16le(rec(2), rec(3)));

  // Outside air temperature: little-endian u16 at record bytes 4..5.
  air.temperature = fahrenheitTenthsToCelsius(u16le(rec(4), rec(5)));

  // Wind speed (record byte 6) and direction (little-endian u16 at 8..9).
  wind.speed = windSpeedMs(rec(6) & 0xff);
  wind.direction = u16le(rec(8), rec(9));

  // Outside relative humidity: record byte 10.
  air.relativeHumidity = rec(10) & 0xff;

  // Rainfall: instantaneous rate (little-endian u16 at 11..12) and daily
  // cumulative total (little-endian u16 at 16..17), both 0.2 mm clicks.
  rain.intensity = rainMm(u16le(rec(11), rec(12)));
  rain.cumulative = rainMm(u16le(rec(16), rec(17)));

  data.air = air;
  data.wind = wind;
  data.rain = rain;

  // --- extras (no vocabulary key) ---

  // 10-minute average wind speed (record byte 7), m/s.
  data.windSpeedTenMinAvg = windSpeedMs(rec(7) & 0xff);

  // UV index (record byte 13).
  data.uv = rec(13) & 0xff;

  // Solar radiation (little-endian u16 at record bytes 14..15), W/m2.
  data.solarRadiation = u16le(rec(14), rec(15));

  // Daily evapotranspiration (little-endian u16 at 18..19): thousandths of an
  // inch -> mm, mirroring upstream getET (value / 1000 * 25.4).
  data.dayEvapotranspiration = round((u16le(rec(18), rec(19)) / 1000) * 25.4, 2);

  // Four soil-moisture channels (centibar) and four leaf-wetness channels.
  var soilMoisture = [];
  var leafWetness = [];
  var i;
  for (i = 0; i < 4; i++) {
    soilMoisture.push(rec(20 + i) & 0xff);
  }
  for (i = 0; i < 4; i++) {
    leafWetness.push(rec(24 + i) & 0xff);
  }
  data.soilMoisture = soilMoisture;
  data.leafWetness = leafWetness;

  // Davis console forecast icon bitmap and 3-hour barometer trend code.
  data.forecastIcons = rec(28) & 0xff;
  data.barometerTrend = rec(29) & 0xff;

  return { data: data };
}
