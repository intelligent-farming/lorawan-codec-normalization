// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LWWS01 (Weather Station: a
// LoRaWAN bridge for a Davis Instruments Vantage Pro2 — air temperature,
// relative humidity, barometric pressure, wind speed/direction, rainfall rate
// and daily total, solar radiation, UV, and particulate matter PM1/PM2.5/PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 "report data" frames, uplink id 0x0B) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-weather.js, attributed in NOTICE). We author the
// normalization here; the upstream string-slicing helpers (getTemperature,
// getPressure, parseDate -> locale string) are NOT reused.
//
// Ported frames (uplink id 0x0B, "report data"):
//   0B 2 00  weather  -> air.{temperature,relativeHumidity,pressure},
//                        wind.{speed,direction}, rain.{intensity,cumulative},
//                        + uv / solarRadiation / dayET / 10-min avg wind extras
//   0B 2 01  PM        -> time + pm1/pm25/pm10 extras
//   0B 3 00  TER+PM    -> air.{temperature,relativeHumidity,pressure},
//                        pm1/pm25/pm10 extras, optional batteryPercent, time
//
// Conversions (faithful to upstream): barometric pressure arrives as Davis
// 0.001 inHg counts (weather frame) and is converted to hPa (x33.863886666667);
// in the TER+PM frame it arrives in the MCF integer-hundredths hPa format. Both
// land in air.pressure (hPa, atmospheric, 900..1100). Temperature in the weather
// frame is degF tenths -> degC; wind speed is mph -> m/s (x0.44704). Battery is
// reported as a PERCENTAGE, so it is emitted as the camelCase extra
// batteryPercent (the vocabulary `battery` is volts). UV, solar radiation, daily
// evapotranspiration, 10-minute average wind, and PM mass concentrations have no
// vocabulary key and are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Enginko/MCF88 packed timestamp: 4 LSB-first bytes assemble a 32-bit word whose
// fields are, MSB-first: year-2000(7) month(4) day(5) hour(5) minute(6)
// second/2(5). Returns an RFC3339 string (treated as UTC). The upstream
// parseDate returns a locale string; we emit RFC3339 instead.
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

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

// MCF integer-hundredths formats, mirroring the upstream getTemperature/
// getPressure/getHumidity helpers but computed numerically (no string slicing).
function mcfTemperature(lo, hi) {
  // signed 16-bit, value is hundredths of a degree C.
  var raw = (((lo & 0xff) + ((hi << 8) & 0xff00)) << 16) >> 16;
  return round(raw / 100, 2);
}

function mcfHumidity(lo) {
  // signed (always positive here); value is half-percent counts.
  var raw = (((lo & 0xff) << 16) >> 16) / 2;
  return round(raw, 2);
}

function mcfPressure(lo, mi, hi) {
  // 24-bit, value is hundredths of a hPa.
  var raw = (lo & 0xff) + ((mi << 8) & 0xff00) + ((hi << 16) & 0xff0000);
  return round(raw / 100, 2);
}

// Davis Vantage Pro2 conversions.
function davisPressure(raw) {
  // raw is thousandths of an inHg; convert inHg -> hPa.
  return round((raw / 1000.0) * 33.863886666667, 2);
}

function fahrenheitTenthsToCelsius(raw) {
  // raw is tenths of a degree F.
  return round((raw / 10.0 - 32) / 1.8, 2);
}

function mphCountToMs(count) {
  return round(count * 0.44704, 2);
}

function rainCountToMm(count) {
  // tipping-bucket counts at 0.2 mm each (matches upstream getRainRate).
  return round(count * 0.2, 2);
}

function etCountToMm(count) {
  // raw is thousandths of an inch; convert to mm.
  return round((count / 1000.0) * 25.4, 2);
}

// Davis wind direction is reported 0..360 where 360 means due north; the
// vocabulary requires 0 <= direction < 360, so 360 folds to 0.
function normalizeDirection(deg) {
  return deg >= 360 ? deg - 360 : deg;
}

function decodeWeather(b) {
  // b is the report-data byte array sliced to start at the weather payload, i.e.
  // index i below is the upstream payloadToByteArray[i] (raw frame byte 3 + i).
  var air = {};
  air.temperature = fahrenheitTenthsToCelsius(u16le(b[4], b[5]));
  air.relativeHumidity = b[10] & 0xff;
  air.pressure = davisPressure(u16le(b[2], b[3]));

  var wind = {};
  wind.speed = mphCountToMs(b[6] & 0xff);
  wind.direction = normalizeDirection(u16le(b[8], b[9]));

  var rain = {};
  rain.intensity = rainCountToMm(u16le(b[11], b[12]));
  rain.cumulative = rainCountToMm(u16le(b[16], b[17]));

  var data = { air: air, wind: wind, rain: rain };
  data.windSpeedAvgTenMinutes = mphCountToMs(b[7] & 0xff);
  data.uv = b[13] & 0xff;
  data.solarRadiation = u16le(b[14], b[15]);
  data.evapotranspirationDay = etCountToMm(u16le(b[18], b[19]));
  data.forecastIcons = b[28] & 0xff;
  data.barometricTrend = (b[29] << 24) >> 24; // signed 8-bit trend code
  return { data: data };
}

function decodePM(b) {
  // b sliced to start at the PM payload: index i = raw frame byte 3 + i.
  // bytes 0..3 are the packed date; pm fields start at index 4.
  var data = {};
  data.pm1 = u16le(b[4], b[5]);
  data.pm25 = u16le(b[6], b[7]);
  data.pm10 = u16le(b[8], b[9]);
  data.time = decodeTime(b[0], b[1], b[2], b[3]);
  return { data: data };
}

function decodeTerPm(b, hasBattery) {
  // b sliced to start at the TER+PM payload: index i = raw frame byte 3 + i.
  // bytes 0..3 packed date; temp[4,5]; humidity[6]; pressure[7,8,9];
  // pm1[10,11]; pm25[12,13]; pm10[14,15]; battery%[16] (optional).
  var air = {};
  air.temperature = mcfTemperature(b[4], b[5]);
  air.relativeHumidity = mcfHumidity(b[6]);
  air.pressure = mcfPressure(b[7], b[8], b[9]);

  var data = { air: air };
  data.pm1 = u16le(b[10], b[11]);
  data.pm25 = u16le(b[12], b[13]);
  data.pm10 = u16le(b[14], b[15]);
  if (hasBattery) {
    data.batteryPercent = b[16] & 0xff;
  }
  data.time = decodeTime(b[0], b[1], b[2], b[3]);
  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var uplinkId = bytes[0];
  if (uplinkId !== 0x0b) {
    return {
      errors: ['unsupported uplink id 0x' + uplinkId.toString(16) + ': not a report-data frame'],
    };
  }

  if (bytes.length < 3) {
    return { errors: ['report-data frame too short: missing group/subtype'] };
  }

  // bytes[1] high nibble is the report group; bytes[2] is the sub-type.
  var group = (bytes[1] >> 4) & 0x0f;
  var subType = bytes[2];

  // The report payload begins at frame byte 3; index helpers above use a view
  // offset by 3 so they read the same indices as the upstream code.
  var body = [];
  var i;
  for (i = 3; i < bytes.length; i++) {
    body.push(bytes[i]);
  }

  if (group === 2 && subType === 0x00) {
    // weather frame: needs indices 0..29 of the body.
    if (body.length < 30) {
      return { errors: ['weather frame too short'] };
    }
    return decodeWeather(body);
  }

  if (group === 2 && subType === 0x01) {
    // PM frame: needs date (0..3) + pm1/pm25/pm10 (4..9).
    if (body.length < 10) {
      return { errors: ['PM frame too short'] };
    }
    return decodePM(body);
  }

  if (group === 3 && subType === 0x00) {
    // TER+PM frame: needs indices 0..15; optional battery at 16.
    if (body.length < 16) {
      return { errors: ['TER+PM frame too short'] };
    }
    var hasBattery = body.length >= 17;
    return decodeTerPm(body, hasBattery);
  }

  return {
    errors: [
      'unsupported report-data frame: group ' + group + ' subtype 0x' + subType.toString(16),
    ],
  };
}
