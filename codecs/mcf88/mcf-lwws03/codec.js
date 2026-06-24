// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCF88 / Enginko MCF-LWWS03 (Outdoor Weather
// Station: barometric pressure, air temperature, humidity, wind speed and
// direction, rainfall, UV, solar radiation, particulate matter / dust).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcf88/decoder-weather.js, attributed
// in NOTICE). We author the normalization here; the upstream string-slicing
// helpers (getPressure, getTemperature, getAtmosphericPressure, etc.) and its
// flat `variable`/`value`/`unit` table output are not reused.
//
// The LWWS03 reports its weather sensor suite in the "report data" uplink
// (frame id 0x0B). Three report sub-frames are relevant:
//   0x0B 0x20 0x00  parseWeather  - Davis-style station: pressure (inHg),
//                                   temperature (degF), wind, rain, UV, solar.
//   0x0B 0x20 0x01  parsePM       - particulate matter only (PM1/PM2.5/PM10).
//   0x0B 0x30 0x00  parseTERPM    - temperature/humidity/pressure (native MCF
//                                   sensor scaling) plus PM and battery.
//
// Unit normalization (vocabulary units):
//   barometric pressure: parseWeather reports inches-of-mercury x1000 -> hPa via
//     value/1000 * 33.863886666667 (atmospheric pressure). parseTERPM reports the
//     native MCF 3-byte pressure x100 -> hPa via /100. Both land in air.pressure.
//   temperature: parseWeather reports degrees Fahrenheit x10 -> degC via
//     (F-32)/1.8. parseTERPM reports the native MCF signed value x100 -> degC.
//   wind speed: mph -> m/s via x0.44704.
//   rainfall: tip count -> mm via x0.2 (rain rate is mm/hour, day rain is mm).
//   evapotranspiration: thousandths-of-inch -> mm via /1000 * 25.4.
//
// Battery is reported as a PERCENTAGE; the vocabulary `battery` is volts, so the
// percentage is emitted as the camelCase extra `batteryPercent`.
//
// Sensor readings the vocabulary does not model (UV index, solar radiation,
// 10-minute average wind speed, day rain / day ET totals, particulate matter,
// soil-moisture / leaf-wetness probe channels, forecast icon, barometer trend)
// are emitted as camelCase extras. Per AUTHORING.md the timestamp is emitted as
// an RFC3339 (UTC) `time`; upstream's locale-dependent toLocaleString() date is
// intentionally not ported.

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

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// MCF88 packed timestamp: 4 LSB bytes -> 32-bit value, fields are
// year-2000(7) month(4) day(5) hour(5) minute(6) second/2(5), MSB-first within
// the assembled word. Returns an RFC3339 string (treated as UTC).
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

// Davis-style weather report (0x0B 0x20 0x00). Field offsets are relative to the
// 3-byte report header (id 0x0B, sub-type 0x20, frame 0x00). Mirrors upstream
// parseWeather, which skips the first two payload bytes after the header.
function parseWeather(bytes) {
  // Minimum length: header(3) + 2 skipped + 28 field bytes (last is barTrend at
  // absolute index 32), i.e. 33 bytes.
  if (bytes.length < 33) {
    return { errors: ['payload too short: truncated weather report'] };
  }
  // Absolute index = 3 (header) + 2 (upstream skips PBA[0],PBA[1]) + field.
  var b = 5;

  var data = {};
  var air = {};
  var wind = {};
  var rain = {};

  // Barometric pressure: inches-of-mercury x1000 -> hPa (atmospheric pressure).
  air.pressure = round((u16le(bytes[b + 0], bytes[b + 1]) / 1000.0) * 33.863886666667, 2);
  // Air temperature: degrees Fahrenheit x10 -> degC.
  air.temperature = round((s16le(bytes[b + 2], bytes[b + 3]) / 10.0 - 32) / 1.8, 2);

  // Wind speed (mph -> m/s) and 10-minute average (extra).
  wind.speed = round((bytes[b + 4] & 0xff) * 0.44704, 2);
  data.windSpeedAvg10min = round((bytes[b + 5] & 0xff) * 0.44704, 2);
  // Wind direction (degrees, 0..359).
  wind.direction = u16le(bytes[b + 6], bytes[b + 7]);

  // Relative humidity (%).
  air.relativeHumidity = bytes[b + 8] & 0xff;

  // Rain rate (tip count -> mm/hour).
  rain.intensity = round(u16le(bytes[b + 9], bytes[b + 10]) * 0.2, 2);

  // UV index and solar radiation (W/m2) - no vocabulary key -> extras.
  data.uvIndex = bytes[b + 11] & 0xff;
  data.solarRadiation = u16le(bytes[b + 12], bytes[b + 13]);

  // Day rain total (tip count -> mm) -> cumulative rainfall.
  rain.cumulative = round(u16le(bytes[b + 14], bytes[b + 15]) * 0.2, 2);

  // Day evapotranspiration (thousandths-of-inch -> mm) - extra.
  data.evapotranspirationDay = round((u16le(bytes[b + 16], bytes[b + 17]) / 1000) * 25.4, 2);

  // Soil-moisture (centibar) and leaf-wetness probe channels - extras.
  var soilMoisture = [];
  var leafWetness = [];
  var i;
  for (i = 0; i < 4; i++) {
    soilMoisture.push(bytes[b + 18 + i] & 0xff);
  }
  for (i = 0; i < 4; i++) {
    leafWetness.push(bytes[b + 22 + i] & 0xff);
  }
  data.soilMoistureChannels = soilMoisture;
  data.leafWetnessChannels = leafWetness;

  // Davis forecast icon bitfield and barometer trend - extras.
  data.forecastIcons = bytes[b + 26] & 0xff;
  data.barometerTrend = bytes[b + 27] & 0xff;

  data.air = air;
  data.wind = wind;
  data.rain = rain;
  return { data: data };
}

// Particulate-matter-only report (0x0B 0x20 0x01): timestamp + PM1/PM2.5/PM10.
function parsePM(bytes) {
  // header(3) + date(4) + 3 x uint16 (6) = 13.
  if (bytes.length < 13) {
    return { errors: ['payload too short: truncated PM report'] };
  }
  var data = {};
  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);
  data.pm1p0 = u16le(bytes[7], bytes[8]);
  data.pm2p5 = u16le(bytes[9], bytes[10]);
  data.pm10 = u16le(bytes[11], bytes[12]);
  return { data: data };
}

// Temperature / humidity / pressure + PM report (0x0B 0x30 0x00). Uses the
// native MCF sensor scaling (signed temperature x100, humidity x2, 3-byte
// pressure x100); an optional trailing battery-percentage byte follows the PM.
function parseTERPM(bytes) {
  // header(3) + date(4) + temp(2) + hum(1) + pressure(3) + 3 x PM uint16 (6) = 19.
  if (bytes.length < 19) {
    return { errors: ['payload too short: truncated TER+PM report'] };
  }
  var data = {};
  var air = {};

  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);
  air.temperature = round(s16le(bytes[7], bytes[8]) / 100, 2);
  air.relativeHumidity = round((bytes[9] & 0xff) / 2, 1);
  air.pressure = round(u24le(bytes[10], bytes[11], bytes[12]) / 100, 2);
  data.air = air;

  data.pm1p0 = u16le(bytes[13], bytes[14]);
  data.pm2p5 = u16le(bytes[15], bytes[16]);
  data.pm10 = u16le(bytes[17], bytes[18]);

  // Optional trailing battery percentage (vocabulary `battery` is volts).
  if (bytes.length > 19) {
    data.batteryPercent = bytes[19] & 0xff;
  }

  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Only the report-data uplink (0x0B) carries the weather sensor suite.
  if (bytes[0] !== 0x0b) {
    return { errors: ['unsupported frame id 0x' + bytes[0].toString(16)] };
  }
  if (bytes.length < 3) {
    return { errors: ['payload too short: truncated report header'] };
  }

  var subType = bytes[1];
  var frame = bytes[2];

  if (subType === 0x20 && frame === 0x00) {
    return parseWeather(bytes);
  }
  if (subType === 0x20 && frame === 0x01) {
    return parsePM(bytes);
  }
  if (subType === 0x30 && frame === 0x00) {
    return parseTERPM(bytes);
  }

  return {
    errors: [
      'unsupported report sub-frame 0x' +
        subType.toString(16) +
        ' 0x' +
        frame.toString(16)
    ]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcf88";
    result.data.model = "mcf-lwws03";
  }
  return result;
}
