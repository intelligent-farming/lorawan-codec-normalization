// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCF88 MCF-LW06DAVPK (LoRaWAN Davis Instruments
// Vantage Pro2 weather station with particulate sensor: air temperature,
// humidity, barometric pressure, wind speed/direction, rainfall, solar
// radiation, UV index and dust PM1/PM2.5/PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCF88 "ReportData" uplink 0x0B with sub-type byte) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcf88/decoder-weather.js, attributed
// in NOTICE). Ported from upstream parseReportData/parseWeather/parsePM/
// parseTERPM; the upstream string-slicing helpers (getTemperature, getPressure,
// getAtmosphericPressure, getWindSpeed, getRainRate, parseDate) are not reused —
// we author the byte-level decode and normalization here.
//
// Unit normalization to the vocabulary:
//   * Weather frame (0x0B/2/00): barometric pressure is reported in milli-inHg
//     (raw/1000 inHg); converted to hPa (x 33.863886666667). Outside temperature
//     is reported in deci-degF; converted to degC ((F - 32) / 1.8). Wind speed is
//     reported in mph; converted to m/s (x 0.44704). Rain rate / day rain are in
//     0.2 mm tips; converted to mm/h and mm. Solar radiation (W/m2), UV index and
//     the 10-minute average wind speed (m/s) have no vocabulary key -> extras.
//   * TERPM frame (0x0B/3/00): temperature is centi-degC, humidity is half-%,
//     pressure is centi-hPa, all already in vocabulary units.
//   * PM frames report dust mass concentration (ug/m3); PM1 has no vocabulary key
//     so PM1/PM2.5/PM10 are emitted as the camelCase extras pm1 / pm2_5 / pm10.
//
// Battery is reported as a PERCENTAGE; the vocabulary `battery` is volts, so it
// is emitted as the camelCase extra `batteryPercent`.

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

// MCF88 packed timestamp: 4 LSB-first bytes -> 32-bit word; fields are
// year-2000(7) month(4) day(5) hour(5) minute(6) second/2(5), MSB-first within
// the assembled word. Returns an RFC3339 string (treated as UTC). Upstream
// formats this with new Date().toLocaleString() (locale-dependent, non-RFC3339);
// we emit a deterministic UTC RFC3339 string instead.
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

// 0x0B / sub 2 / 00: Davis weather report. The 0x0B uplink id, the sub-type
// nibble byte and the 00 selector byte occupy bytes 0..2; sensor fields follow
// from byte 3. Bytes 3..4 are reserved/unused upstream.
function parseWeather(bytes) {
  var b = bytes; // indices below are absolute payload offsets
  // Need fields through b[20] (cumulative day rain). Require the full record.
  if (bytes.length < 21) {
    return { errors: ['weather frame too short'] };
  }

  var data = {};
  var air = {};
  var wind = {};
  var rain = {};

  // Barometric pressure: raw/1000 inHg -> hPa.
  var inHg = u16le(b[5], b[6]) / 1000.0;
  air.pressure = round(inHg * 33.863886666667, 1);

  // Outside temperature: deci-degF -> degC.
  var degF = s16le(b[7], b[8]) / 10.0;
  air.temperature = round((degF - 32) / 1.8, 2);

  // Wind speed (mph -> m/s) and 10-minute average (extra).
  wind.speed = round(b[9] * 0.44704, 2);
  data.windSpeedAvg10m = round(b[10] * 0.44704, 2);

  // Wind direction (degrees, 0..359).
  wind.direction = u16le(b[11], b[12]);

  // Outside relative humidity (%).
  air.relativeHumidity = b[13];

  // Rain rate (0.2 mm tips -> mm/h) and cumulative day rain (0.2 mm tips -> mm).
  rain.intensity = round(u16le(b[14], b[15]) * 0.2, 2);
  rain.cumulative = round(u16le(b[19], b[20]) * 0.2, 2);

  // UV index and solar radiation (W/m2) -> extras.
  data.uvIndex = b[16];
  data.solarRadiation = u16le(b[17], b[18]);

  data.air = air;
  data.wind = wind;
  data.rain = rain;
  return { data: data };
}

// 0x0B / sub 2 / 01: particulate-only report (PM1/PM2.5/PM10, ug/m3) with a
// leading timestamp.
function parsePM(bytes) {
  if (bytes.length < 13) {
    return { errors: ['PM frame too short'] };
  }
  var data = {};
  data.pm1 = u16le(bytes[7], bytes[8]);
  data.pm2_5 = u16le(bytes[9], bytes[10]);
  data.pm10 = u16le(bytes[11], bytes[12]);
  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);
  return { data: data };
}

// 0x0B / sub 3 / 00: combined temperature/humidity/pressure + particulate
// report with a leading timestamp and an optional trailing battery-percentage
// byte.
function parseTERPM(bytes) {
  if (bytes.length < 19) {
    return { errors: ['TERPM frame too short'] };
  }
  var data = {};
  var air = {};

  air.temperature = round(s16le(bytes[7], bytes[8]) / 100, 2);
  air.relativeHumidity = round(bytes[9] / 2, 1);
  air.pressure = round(u24le(bytes[10], bytes[11], bytes[12]) / 100, 2);
  data.air = air;

  data.pm1 = u16le(bytes[13], bytes[14]);
  data.pm2_5 = u16le(bytes[15], bytes[16]);
  data.pm10 = u16le(bytes[17], bytes[18]);

  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);

  // Optional trailing battery-percentage byte.
  if (bytes.length > 19) {
    data.batteryPercent = bytes[19];
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
    return { errors: ['truncated report-data header'] };
  }

  // Sub-type is the high nibble of byte 1; the report selector is byte 2.
  var sub = (bytes[1] >> 4) & 0x0f;
  var selector = bytes[2];

  if (sub === 2 && selector === 0x00) {
    return parseWeather(bytes);
  }
  if (sub === 2 && selector === 0x01) {
    return parsePM(bytes);
  }
  if (sub === 3 && selector === 0x00) {
    return parseTERPM(bytes);
  }

  return {
    errors: [
      'unsupported report-data frame sub 0x' +
        sub.toString(16) +
        ' selector 0x' +
        selector.toString(16)
    ]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcf88";
    result.data.model = "mcf-lw06davpk";
  }
  return result;
}
