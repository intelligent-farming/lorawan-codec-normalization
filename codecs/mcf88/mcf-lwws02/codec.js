// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCF88 / Enginko MCF-LWWS02 (LoRaWAN weather
// station built on a Davis Instruments Vantage Pro2: barometric pressure,
// outside temperature, humidity, wind speed/direction, rainfall, UV, solar
// radiation, evapotranspiration).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcf88/decoder-weather.js, codec
// id `mcf-lwws0x-codec`, attributed in NOTICE). We author the normalization
// here; the upstream TTNfrom/TTNto/parseWeather string-slicing helpers are not
// reused as output.
//
// Ported from upstream `decodeUplink` -> `parseReportData` -> `parseWeather`:
// this device's weather telemetry arrives as a "report data" frame with frame
// id 0x0B, report type nibble 2 and subtype byte 0x00. After the 3-byte header
// (0B, 0x2_, 00) the body is a fixed little-endian record. Field offsets below
// are relative to the start of that body (i.e. full-payload byte index = body
// offset + 3), matching upstream's `payloadToByteArray.slice(3)` indexing.
//
// The Davis sensor block reports in imperial units; upstream converts and so do
// we, normalizing to the vocabulary's units:
//   barometric pressure: inHg*1000 (LE16) -> hPa  (x33.863886666667 / 1000)
//   outside temperature: degF*10  (LE16) -> degC  ((degF - 32) / 1.8)
//   wind / 10-min avg wind: mph (u8)      -> m/s   (x0.44704)
//   rain rate / day rain: 0.2mm counts (LE16) -> mm/h and mm (x0.2)
//   day ET: 0.001in (LE16)               -> mm    (/1000 * 25.4)
// Wind direction (LE16 deg), humidity (u8 %), UV index, solar radiation
// (W/m2), forecast icons and barometer trend are read as-is.
//
// Mapping to the vocabulary: pressure->air.pressure, temperature->
// air.temperature, humidity->air.relativeHumidity, wind speed->wind.speed,
// wind direction->wind.direction, rain rate->rain.intensity, day rain->
// rain.cumulative. Sensor readings the vocabulary does not model (10-minute
// average wind speed, UV index, solar radiation, daily evapotranspiration,
// forecast icon code, barometer trend) are emitted as camelCase extras. UV and
// solar radiation are deliberately NOT mapped to air.lightIntensity (lux): they
// are not illuminance. This weather frame carries no battery field, so neither
// `battery` (V) nor `batteryPercent` is emitted.

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

  // Only the weather report-data frame (0x0B) is decoded by this device's
  // weather codec. Upstream returns "Error on decoding payload" for every other
  // uplink id and for report frames it does not recognize.
  if (uplinkId !== 0x0b) {
    return {
      errors: ['unsupported uplink id 0x' + uplinkId.toString(16)]
    };
  }

  if (bytes.length < 3) {
    return { errors: ['report-data frame too short'] };
  }

  // Report type lives in the high nibble of byte 1; the subtype is byte 2.
  // parseWeather is the (type 2, subtype 0x00) branch.
  var reportType = (bytes[1] >> 4) & 0x0f;
  var subtype = bytes[2];
  if (reportType !== 2 || subtype !== 0x00) {
    return {
      errors: [
        'unsupported report-data frame: type ' +
          reportType +
          ' subtype 0x' +
          subtype.toString(16)
      ]
    };
  }

  // Body starts at byte 3. Upstream reads through body offset 29 (full byte 32),
  // so the frame must be at least 33 bytes.
  var b = 3;
  if (bytes.length < b + 30) {
    return { errors: ['weather frame too short: need at least 33 bytes'] };
  }

  // Barometric pressure: inHg*1000 (LE16) at body[2..3] -> hPa.
  var pressureInHg = u16le(bytes[b + 2], bytes[b + 3]) / 1000.0;
  var pressure = round(pressureInHg * 33.863886666667, 2);

  // Outside temperature: degF*10 (LE16) at body[4..5] -> degC.
  var tempF = u16le(bytes[b + 4], bytes[b + 5]) / 10.0;
  var temperature = round((tempF - 32) / 1.8, 2);

  // Wind speed (mph, u8) at body[6]; 10-minute average wind speed at body[7].
  var windSpeed = round((bytes[b + 6] & 0xff) * 0.44704, 2);
  var windSpeedAvg10min = round((bytes[b + 7] & 0xff) * 0.44704, 2);

  // Wind direction (LE16 degrees) at body[8..9].
  var windDirection = u16le(bytes[b + 8], bytes[b + 9]);

  // Outside relative humidity (u8 %) at body[10].
  var humidity = bytes[b + 10] & 0xff;

  // Rain rate: 0.2mm tip counts (LE16) at body[11..12] -> mm/h.
  var rainIntensity = round(u16le(bytes[b + 11], bytes[b + 12]) * 0.2, 2);

  // UV index (u8) at body[13].
  var uvIndex = bytes[b + 13] & 0xff;

  // Solar radiation (W/m2, LE16) at body[14..15].
  var solarRadiation = u16le(bytes[b + 14], bytes[b + 15]);

  // Daily cumulative rain: 0.2mm counts (LE16) at body[16..17] -> mm.
  var rainCumulative = round(u16le(bytes[b + 16], bytes[b + 17]) * 0.2, 2);

  // Daily evapotranspiration: 0.001in (LE16) at body[18..19] -> mm.
  var dayET = round((u16le(bytes[b + 18], bytes[b + 19]) / 1000.0) * 25.4, 2);

  // Forecast icon bitfield (u8) at body[28]; barometer trend (u8) at body[29].
  var forecastIcons = bytes[b + 28] & 0xff;
  var barometerTrend = bytes[b + 29] & 0xff;

  var data = {
    air: {
      temperature: temperature,
      relativeHumidity: round(humidity, 1),
      pressure: pressure
    },
    wind: {
      speed: windSpeed,
      direction: windDirection
    },
    rain: {
      intensity: rainIntensity,
      cumulative: rainCumulative
    },
    windSpeedAvg10min: windSpeedAvg10min,
    uvIndex: uvIndex,
    solarRadiation: solarRadiation,
    evapotranspiration: dayET,
    forecastIcons: forecastIcons,
    barometerTrend: barometerTrend
  };

  return { data: data };
}
