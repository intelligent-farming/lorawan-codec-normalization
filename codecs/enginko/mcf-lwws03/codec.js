// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko MCF-LWWS03 (LoRaWAN weather station built
// on a Davis Instruments Vantage Pro2: air temperature, humidity, barometric
// pressure, wind speed/direction, rainfall, UV, solar radiation, and dust /
// particulate matter PM1/PM2.5/PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire format
// (Enginko/MCF88 "report data" frame, uplink id 0x0B) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-weather.js, attributed in NOTICE). We author the
// normalization here; the upstream string-slicing helpers (getTemperature and
// getPressure) and its broken locale-string `parseDate` are not reused.
//
// Frames handled (the report-data subtypes this device emits):
//   0x0B 2x 00  parseWeather : Davis weather block (no PM, no usable timestamp)
//   0x0B 2x 01  parsePM      : standalone PM1/PM2.5/PM10 block
//   0x0B 3x 00  parseTERPM   : temp/humidity/pressure + PM block (+ battery %)
//
// Unit normalization (matches upstream constants):
//   pressure  : Davis raw is inHg x1000; inHg x 33.863886666667 -> hPa (atmospheric)
//   temperature (weather): degF x10 -> degC via (F - 32) / 1.8
//   temperature (terpm)  : signed centi-degC -> degC (/100)
//   wind speed: mph (1 byte) x 0.44704 -> m/s
//   rain      : Davis "clicks" (0.2 mm each) -> mm  (rate -> mm/hour, day -> mm)
//
// Battery (parseTERPM only) is reported as a PERCENTAGE; the vocabulary `battery`
// is volts, so the percentage is emitted as the camelCase extra `batteryPercent`.
// UV index, solar radiation, evapotranspiration, the 10-minute average wind, the
// forecast icon / barometer trend, and particulate matter have no vocabulary key
// and are emitted as camelCase extras.

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

function u24le(lo, mi, hi) {
  return ((hi << 16) | (mi << 8) | lo) & 0xffffff;
}

// Davis raw barometric value (inHg x 1000) -> hPa.
function inHgRawToHpa(raw) {
  return round((raw / 1000) * 33.863886666667, 2);
}

// Davis raw temperature (degF x 10) -> degC.
function fahrenheitRawToCelsius(raw) {
  return round((raw / 10 - 32) / 1.8, 2);
}

// Wind speed in mph -> m/s.
function mphToMps(mph) {
  return round(mph * 0.44704, 2);
}

// Davis rain "clicks" (0.2 mm per click) -> mm.
function clicksToMm(clicks) {
  return round(clicks * 0.2, 2);
}

// 0x0B 2x 00 : Davis weather block. After the 3-byte header (id, subtype-high,
// subtype-low) two bytes are reserved, then the Davis loop fields follow.
function parseWeather(bytes) {
  var d = 3; // first data byte after the 3-byte report header
  // d+0, d+1 reserved (upstream does not decode them)
  if (d + 30 > bytes.length) {
    return { errors: ['weather frame too short'] };
  }

  var data = {};
  var air = {};
  var wind = {};
  var rain = {};

  air.pressure = inHgRawToHpa(u16le(bytes[d + 2], bytes[d + 3]));
  air.temperature = fahrenheitRawToCelsius(s16le(bytes[d + 4], bytes[d + 5]));
  air.relativeHumidity = bytes[d + 10]; // Davis reports whole-percent directly

  wind.speed = mphToMps(bytes[d + 6]);
  wind.direction = u16le(bytes[d + 8], bytes[d + 9]);

  rain.intensity = clicksToMm(u16le(bytes[d + 11], bytes[d + 12])); // mm/hour
  rain.cumulative = clicksToMm(u16le(bytes[d + 16], bytes[d + 17])); // day rain (mm)

  data.air = air;
  data.wind = wind;
  data.rain = rain;

  // Extras: no vocabulary key.
  data.windSpeedAvg10min = mphToMps(bytes[d + 7]);
  data.uvIndex = bytes[d + 13];
  data.solarRadiation = u16le(bytes[d + 14], bytes[d + 15]); // W/m2
  data.dailyEvapotranspiration = round(
    (u16le(bytes[d + 18], bytes[d + 19]) / 1000) * 25.4,
    2
  ); // mm
  data.forecastIcons = bytes[d + 28];
  data.barometerTrend = s16le(bytes[d + 29], 0); // single signed byte

  return { data: data };
}

// 0x0B 2x 01 : standalone particulate-matter block.
function parsePM(bytes) {
  var d = 3; // after 3-byte report header
  // d+0..d+3 packed timestamp (upstream decodes via a broken locale string; we
  // skip it). PM values follow at d+4.
  if (d + 10 > bytes.length) {
    return { errors: ['PM frame too short'] };
  }

  var data = {};
  data.pm1 = u16le(bytes[d + 4], bytes[d + 5]); // ug/m3
  data.pm25 = u16le(bytes[d + 6], bytes[d + 7]); // ug/m3
  data.pm10 = u16le(bytes[d + 8], bytes[d + 9]); // ug/m3
  return { data: data };
}

// 0x0B 3x 00 : combined temperature / humidity / pressure + PM block.
function parseTERPM(bytes) {
  var d = 3; // after 3-byte report header
  // d+0..d+3 packed timestamp (skipped, see parsePM).
  if (d + 16 > bytes.length) {
    return { errors: ['TERPM frame too short'] };
  }

  var data = {};
  var air = {};
  air.temperature = round(s16le(bytes[d + 4], bytes[d + 5]) / 100, 2);
  air.relativeHumidity = round(bytes[d + 6] / 2, 1); // half-percent units here
  air.pressure = round(u24le(bytes[d + 7], bytes[d + 8], bytes[d + 9]) / 100, 2);
  data.air = air;

  data.pm1 = u16le(bytes[d + 10], bytes[d + 11]); // ug/m3
  data.pm25 = u16le(bytes[d + 12], bytes[d + 13]); // ug/m3
  data.pm10 = u16le(bytes[d + 14], bytes[d + 15]); // ug/m3

  // Optional trailing battery-percentage byte.
  if (d + 16 < bytes.length) {
    data.batteryPercent = bytes[d + 16];
  }

  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var id = bytes[0];
  if (id !== 0x0b) {
    return { errors: ['unsupported frame id 0x' + id.toString(16)] };
  }
  if (bytes.length < 3) {
    return { errors: ['report frame too short'] };
  }

  // Report subtype: high nibble of byte 1, plus the byte-2 selector.
  var family = (bytes[1] >> 4) & 0x0f;
  var selector = bytes[2];

  if (family === 0x2 && selector === 0x00) {
    return parseWeather(bytes);
  }
  if (family === 0x2 && selector === 0x01) {
    return parsePM(bytes);
  }
  if (family === 0x3 && selector === 0x00) {
    return parseTERPM(bytes);
  }

  return {
    errors: [
      'unsupported report subtype ' +
        family.toString(16) +
        '/' +
        selector.toString(16)
    ]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enginko";
    result.data.model = "mcf-lwws03";
  }
  return result;
}
