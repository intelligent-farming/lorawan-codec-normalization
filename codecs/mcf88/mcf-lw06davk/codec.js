// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCF88 / Enginko MCF-LW06DAVK (Davis-anemometer
// weather station: barometric pressure, outside air temperature, humidity, wind
// speed/direction, rainfall, solar radiation, UV, plus Davis soil/leaf station
// extras).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCF88 "report data" frame 0x0B, sub-type 0x2/0x00 = Davis weather
// station) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcf88 mcf-lwws0x-codec
// decoder-weather.js parseReportData/parseWeather, attributed in NOTICE). We
// author the normalization here; the upstream getXxx string-padding helpers and
// the flat normalizeUplink/TTNto output are not reused.
//
// Davis station fields are reported in imperial / vendor units and are
// normalized to the vocabulary here:
//   - barometric pressure: inHg x 1000 (LE16) -> hPa (x 33.863886666667 / 1000),
//     emitted as air.pressure (atmospheric, 900..1100 hPa band).
//   - outside temperature: degF x 10 (LE16, signed-by-sign-extension) ->
//     air.temperature degC ((degF - 32) / 1.8).
//   - humidity: percent -> air.relativeHumidity.
//   - wind speed: mph -> wind.speed m/s (x 0.44704).
//   - wind direction: degrees -> wind.direction (0..<360).
//   - rain rate: 0.2 mm Davis tip clicks -> rain.intensity mm/h (x 0.2).
//   - day rain: 0.2 mm Davis tip clicks -> rain.cumulative mm (x 0.2).
// Sensor readings the vocabulary does not model are emitted as camelCase extras:
//   solarRadiation (W/m2), uvIndex, windSpeedAvg10Min (m/s), dayET (mm),
//   soilMoistureCentibar (array, centibar), leafWetness (array, index),
//   forecastIcons, barometricTrend.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

// 16-bit little-endian value, sign-extended to a signed 16-bit integer.
function s16le(lo, hi) {
  return (u16le(lo, hi) << 16) >> 16;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var uplinkId = bytes[0];
  if (uplinkId !== 0x0b) {
    return {
      errors: ['unsupported frame id 0x' + uplinkId.toString(16)]
    };
  }

  // Report-data routing: high nibble of byte 1 is the report type, byte 2 the
  // sub-type. 0x2 / 0x00 is the Davis weather-station frame.
  var reportType = (bytes[1] >> 4) & 0x0f;
  var subType = bytes[2];
  if (reportType !== 0x2 || subType !== 0x00) {
    return {
      errors: [
        'frame 0x0b report-type ' +
          reportType +
          '/sub-type ' +
          subType +
          ' is not a Davis weather frame'
      ]
    };
  }

  // The weather record begins at byte 3. Field f (per the upstream layout)
  // lives at absolute byte 3 + f; the smallest record used here reaches f=17
  // (day-rain high byte), and the full Davis record reaches f=29 (bar trend).
  // Require at least through the wind/rain/solar/UV block (f=17 -> byte 20).
  if (bytes.length < 21) {
    return { errors: ['payload too short: truncated Davis weather frame'] };
  }

  function b(f) {
    return bytes[3 + f] & 0xff;
  }
  function present(f) {
    return 3 + f < bytes.length;
  }

  var air = {};
  // Barometric (atmospheric) pressure: inHg x 1000 -> hPa.
  air.pressure = round((u16le(b(2), b(3)) / 1000) * 33.863886666667, 2);
  // Outside air temperature: degF x 10 -> degC.
  air.temperature = round((s16le(b(4), b(5)) / 10 - 32) / 1.8, 2);
  // Relative humidity (%).
  air.relativeHumidity = round(b(10), 2);

  var wind = {};
  // Wind speed: mph -> m/s.
  wind.speed = round(b(6) * 0.44704, 2);
  // Wind direction (degrees, 0..359).
  wind.direction = round(u16le(b(8), b(9)), 2);

  var rain = {};
  // Rain rate: 0.2 mm tip clicks -> mm/h.
  rain.intensity = round(u16le(b(11), b(12)) * 0.2, 2);
  // Day (cumulative) rain: 0.2 mm tip clicks -> mm.
  rain.cumulative = round(u16le(b(16), b(17)) * 0.2, 2);

  var data = {};
  data.air = air;
  data.wind = wind;
  data.rain = rain;

  // 10-minute average wind speed: mph -> m/s (no vocabulary key -> extra).
  data.windSpeedAvg10Min = round(b(7) * 0.44704, 2);
  // UV index (no vocabulary key -> extra).
  data.uvIndex = b(13);
  // Solar radiation W/m2 (no vocabulary key -> extra).
  data.solarRadiation = u16le(b(14), b(15));

  // The following fields are only present on the full Davis record.
  if (present(19)) {
    // Day evapotranspiration: in/1000 -> mm (no vocabulary key -> extra).
    data.dayET = round((u16le(b(18), b(19)) / 1000) * 25.4, 2);
  }
  if (present(23)) {
    // Davis soil-moisture stations report centibar, not the vocabulary's
    // soil.moisture percentage -> camelCase extra array.
    data.soilMoistureCentibar = [b(20), b(21), b(22), b(23)];
  }
  if (present(27)) {
    // Leaf wetness index (no vocabulary key -> extra array).
    data.leafWetness = [b(24), b(25), b(26), b(27)];
  }
  if (present(28)) {
    data.forecastIcons = b(28);
  }
  if (present(29)) {
    data.barometricTrend = b(29);
  }

  return { data: data };
}
