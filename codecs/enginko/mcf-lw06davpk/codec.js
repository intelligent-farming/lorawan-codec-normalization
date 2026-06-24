// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LW06DAVPK (Davis Instruments
// Vantage Pro2 weather station with air quality: air temperature, humidity,
// barometric pressure, wind speed/direction, rainfall, solar radiation, UV, and
// particulate matter PM1 / PM2.5 / PM10). Enginko is the MCF88 rebrand.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 "report data" frame, uplinkId 0x0B) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-weather.js, attributed in NOTICE). We author the
// normalization here; the upstream string-slicing helpers (getTemperature,
// getPressure, parseDate's toLocaleString, the TTNto array flattening) are not
// reused.
//
// This codec ports the three report-data sub-frames the device emits:
//   0B 2X 00 ...  -> Davis weather block (parseWeather upstream)
//   0B 2X 01 ...  -> particulate-matter block (parsePM upstream)
//   0B 3X 00 ...  -> combined temp/humidity/pressure + PM block (parseTERPM)
//
// Davis sensors are reported in imperial units: barometric pressure in inHg
// (x1000), temperature in degF (x10), wind speed in mph, rainfall as 0.2 mm
// tip counts. These are converted to the vocabulary units (hPa, degC, m/s, mm).
// air.pressure is ATMOSPHERIC (barometric) pressure in hPa.
//
// Vocabulary mappings: temperature->air.temperature, humidity->
// air.relativeHumidity, pressure->air.pressure, windSpeed->wind.speed,
// windDirection->wind.direction, rainRate->rain.intensity, dayRain->
// rain.cumulative. Sensor readings the vocabulary does not model are emitted as
// camelCase extras: solarRadiation (W/m2), uvIndex, evapotranspiration (mm),
// tenMinutesAvgWindSpeed (m/s), and dust/particulate matter pm1, pm2_5, pm10
// (ug/m3). Battery is reported as a PERCENTAGE, so it is emitted as the
// camelCase extra batteryPercent (the vocabulary `battery` is volts).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function u24le(lo, mi, hi) {
  return ((hi << 16) | (mi << 8) | lo) & 0xffffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// MCF88/Enginko packed timestamp: 4 little-endian bytes assembled into a 32-bit
// word, fields (MSB-first) year-2000(7) month(4) day(5) hour(5) minute(6)
// second/2(5). Returns an RFC3339 string treated as UTC. (Upstream parseDate
// renders this through toLocaleString(), which is locale/timezone-dependent and
// not console-safe; we emit a deterministic UTC timestamp instead.)
function decodeTime(b0, b1, b2, b3) {
  var v = ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
  var year = ((v >>> 25) & 0x7f) + 2000;
  var month = (v >>> 21) & 0x0f;
  var day = (v >>> 16) & 0x1f;
  var hour = (v >>> 11) & 0x1f;
  var minute = (v >>> 5) & 0x3f;
  var second = (v & 0x1f) * 2;
  return (
    year +
    '-' +
    pad2(month) +
    '-' +
    pad2(day) +
    'T' +
    pad2(hour) +
    ':' +
    pad2(minute) +
    ':' +
    pad2(second) +
    'Z'
  );
}

// inHg (x1000) -> hPa: value/1000 inHg * 33.863886666667 hPa/inHg.
function inHgThousandthsToHpa(raw) {
  return round((raw / 1000) * 33.863886666667, 2);
}

// degF (x10) -> degC.
function fahrenheitTenthsToCelsius(raw) {
  return round((raw / 10 - 32) / 1.8, 2);
}

// mph -> m/s.
function mphToMs(raw) {
  return round(raw * 0.44704, 2);
}

// 0.2 mm rain-gauge tip counts -> mm.
function rainCountsToMm(raw) {
  return round(raw * 0.2, 2);
}

// Davis daily ET counts (thousandths of an inch) -> mm.
function etCountsToMm(raw) {
  return round((raw / 1000) * 25.4, 2);
}

// Davis weather block: 0B 2X 00. Byte layout (offset from start of `bytes`):
//   [0]=0x0B [1]=0x2X [2]=0x00 [3..4]=sub-header (ignored) then:
//   [5..6]   barometric pressure (inHg x1000, LE)
//   [7..8]   outside temperature (degF x10, LE, signed)
//   [9]      wind speed (mph)
//   [10]     10-minute average wind speed (mph)
//   [11..12] wind direction (deg, LE)
//   [13]     outside humidity (%)
//   [14..15] rain rate (0.2 mm counts, LE)
//   [16]     UV index
//   [17..18] solar radiation (W/m2, LE)
//   [19..20] day rain (0.2 mm counts, LE)
//   [21..22] day evapotranspiration (0.001 in counts, LE)
//   [23..30] soil moisture x4 / leaf wetness x4 (not emitted)
//   [31] forecast icons, [32] bar trend (not emitted)
function decodeWeather(bytes) {
  if (bytes.length < 23) {
    return { errors: ['weather frame too short'] };
  }

  var air = {};
  air.temperature = fahrenheitTenthsToCelsius(s16le(bytes[7], bytes[8]));
  air.relativeHumidity = bytes[13];
  air.pressure = inHgThousandthsToHpa(u16le(bytes[5], bytes[6]));

  var wind = {};
  wind.speed = mphToMs(bytes[9]);
  wind.direction = u16le(bytes[11], bytes[12]);

  var rain = {};
  rain.intensity = rainCountsToMm(u16le(bytes[14], bytes[15]));
  rain.cumulative = rainCountsToMm(u16le(bytes[19], bytes[20]));

  var data = { air: air, wind: wind, rain: rain };
  data.tenMinutesAvgWindSpeed = mphToMs(bytes[10]);
  data.uvIndex = bytes[16];
  data.solarRadiation = u16le(bytes[17], bytes[18]);
  data.evapotranspiration = etCountsToMm(u16le(bytes[21], bytes[22]));
  return { data: data };
}

// Particulate-matter block: 0B 2X 01. Byte layout:
//   [0]=0x0B [1]=0x2X [2]=0x01 [3..6]=timestamp (LE)
//   [7..8] PM1, [9..10] PM2.5, [11..12] PM10 (ug/m3, LE)
function decodePm(bytes) {
  if (bytes.length < 13) {
    return { errors: ['PM frame too short'] };
  }
  var data = {};
  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);
  data.pm1 = u16le(bytes[7], bytes[8]);
  data.pm2_5 = u16le(bytes[9], bytes[10]);
  data.pm10 = u16le(bytes[11], bytes[12]);
  return { data: data };
}

// Combined temp/humidity/pressure + PM block: 0B 3X 00. Byte layout:
//   [0]=0x0B [1]=0x3X [2]=0x00 [3..6]=timestamp (LE)
//   [7..8]   temperature (degC x100, LE, signed)
//   [9]      humidity (raw, /2 = %)
//   [10..12] pressure (hPa x100, LE)
//   [13..14] PM1, [15..16] PM2.5, [17..18] PM10 (ug/m3, LE)
//   [19]     battery (%), optional
function decodeTerPm(bytes) {
  if (bytes.length < 19) {
    return { errors: ['TER+PM frame too short'] };
  }

  var air = {};
  air.temperature = round(s16le(bytes[7], bytes[8]) / 100, 2);
  air.relativeHumidity = round(bytes[9] / 2, 1);
  air.pressure = round(u24le(bytes[10], bytes[11], bytes[12]) / 100, 2);

  var data = { air: air };
  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);
  data.pm1 = u16le(bytes[13], bytes[14]);
  data.pm2_5 = u16le(bytes[15], bytes[16]);
  data.pm10 = u16le(bytes[17], bytes[18]);
  if (bytes.length > 19) {
    data.batteryPercent = bytes[19];
  }
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 3) {
    return { errors: ['empty payload'] };
  }

  if (bytes[0] !== 0x0b) {
    return { errors: ['unsupported uplink id 0x' + bytes[0].toString(16)] };
  }

  var typeMajor = (bytes[1] >> 4) & 0x0f;
  var subType = bytes[2];

  if (typeMajor === 2 && subType === 0x00) {
    return decodeWeather(bytes);
  }
  if (typeMajor === 2 && subType === 0x01) {
    return decodePm(bytes);
  }
  if (typeMajor === 3 && subType === 0x00) {
    return decodeTerPm(bytes);
  }

  return {
    errors: [
      'unsupported report-data frame type ' +
        typeMajor +
        '/0x' +
        subType.toString(16),
    ],
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enginko";
    result.data.model = "mcf-lw06davpk";
  }
  return result;
}
