// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko MCF-LW06DAVK (Davis-anemometer weather
// station: barometric pressure, air temperature, humidity, wind speed and
// direction, rainfall/precipitation, solar radiation, UV).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko "report data" weather frame: uplinkId 0x0B, subtype 0x2,
// report type 0x00, then a fixed block of little-endian Davis-console fields)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/enginko/decoder-weather.js
// `parseWeather`, attributed in NOTICE). We author the normalization here; the
// upstream string-building helpers and array output are not reused.
//
// Field block (byte offsets into the uplink, LE = little-endian):
//   [0]      uplinkId 0x0B
//   [1]      subtype nibble: high nibble must be 0x2
//   [2]      report type: 0x00 (weather)
//   [5..6]   pressure: LE u16 of inHg*1000; hPa = inHg * 33.863886666667
//   [7..8]   outside temperature: LE u16, tenths of degF; degC = (degF-32)/1.8
//   [9]      wind speed (mph); m/s = mph * 0.44704
//   [10]     10-minute average wind speed (mph)
//   [11..12] wind direction (degrees)
//   [13]     outside humidity (%)
//   [14..15] rain rate: LE u16 of 0.2 mm counts; mm/h = counts * 0.2
//   [16]     UV index
//   [17..18] solar radiation (W/m2)
//   [19..20] day rain: LE u16 of 0.2 mm counts; mm = counts * 0.2
//   [21..22] day evapotranspiration: LE u16; mm = (counts/1000) * 25.4
//   [23..26] soil moisture stations 1..4 (centibar)
//   [27..30] leaf wetness stations 1..4
//   [31]     forecast icons bitfield
//   [32]     bar trend
//
// Mapping to the shared vocabulary: pressure -> air.pressure (hPa, atmospheric),
// outside temperature -> air.temperature, humidity -> air.relativeHumidity, wind
// speed/direction -> wind.speed/wind.direction, rain rate -> rain.intensity, day
// rain -> rain.cumulative. Fields the vocabulary does not model are emitted as
// camelCase extras: solarRadiation (W/m2), uvIndex, windSpeed10mAvg (m/s), dayET
// (mm), soilMoisture (centibar array), leafWetness (array), forecastIcons,
// barTrend. This frame carries no battery reading.

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

  if (bytes[0] !== 0x0b) {
    return { errors: ['unsupported uplink id 0x' + bytes[0].toString(16)] };
  }

  // Subtype is the high nibble of byte[1] (upstream tests hex char 2 === '2'),
  // report type is byte[2] (hex chars 4..5 === '00').
  if (bytes.length < 3 || (bytes[1] >> 4) !== 0x2 || bytes[2] !== 0x00) {
    return { errors: ['not a weather report frame'] };
  }

  if (bytes.length < 33) {
    return { errors: ['payload too short: weather frame needs 33 bytes, got ' + bytes.length] };
  }

  var pressure = round(u16le(bytes[5], bytes[6]) / 1000 * 33.863886666667, 2);
  var temperature = round((u16le(bytes[7], bytes[8]) / 10 - 32) / 1.8, 2);
  var windSpeed = round(bytes[9] * 0.44704, 2);
  var windSpeed10mAvg = round(bytes[10] * 0.44704, 2);
  var windDirection = round(u16le(bytes[11], bytes[12]), 2);
  var humidity = round(bytes[13], 2);
  var rainRate = round(u16le(bytes[14], bytes[15]) * 0.2, 2);
  var uvIndex = round(bytes[16], 2);
  var solarRadiation = round(u16le(bytes[17], bytes[18]), 2);
  var dayRain = round(u16le(bytes[19], bytes[20]) * 0.2, 2);
  var dayET = round(u16le(bytes[21], bytes[22]) / 1000 * 25.4, 2);

  var soilMoisture = [
    round(bytes[23], 2),
    round(bytes[24], 2),
    round(bytes[25], 2),
    round(bytes[26], 2)
  ];
  var leafWetness = [bytes[27], bytes[28], bytes[29], bytes[30]];
  var forecastIcons = bytes[31];
  var barTrend = bytes[32];

  var data = {
    air: {
      temperature: temperature,
      relativeHumidity: humidity,
      pressure: pressure
    },
    wind: {
      speed: windSpeed,
      direction: windDirection
    },
    rain: {
      intensity: rainRate,
      cumulative: dayRain
    },
    solarRadiation: solarRadiation,
    uvIndex: uvIndex,
    windSpeed10mAvg: windSpeed10mAvg,
    dayET: dayET,
    soilMoisture: soilMoisture,
    leafWetness: leafWetness,
    forecastIcons: forecastIcons,
    barTrend: barTrend
  };

  return { data: data };
}
