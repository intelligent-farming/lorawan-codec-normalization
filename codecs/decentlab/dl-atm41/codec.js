// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-ATM41 (Eleven Parameter Weather
// Station: solar radiation, precipitation, lightning, wind speed/direction,
// air temperature, vapor/atmospheric pressure, relative humidity, tilt).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit device id, 16-bit sensor
// flags bitmap, then per-flagged-sensor blocks of 16-bit big-endian words)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-atm41.js, attributed in
// NOTICE).
//
// Decentlab reports "Battery voltage" already in volts, so it maps directly to
// the vocabulary's `battery` field. Atmospheric pressure is reported in kPa;
// the vocabulary's `air.pressure` is hPa, so it is multiplied by 10. Sensor
// readings the vocabulary does not model (solar radiation W/m2, lightning strike
// count and distance, maximum/north/east wind speed, vapor pressure, internal
// sensor temperature, X/Y orientation angle, compass heading) are emitted as
// camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short: need at least 5 header bytes'] };
  }

  var version = bytes[0];
  if (version !== 2) {
    return { errors: ["protocol version " + version + " doesn't match v2"] };
  }

  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table.
  // bit0: 17-word weather block; bit1: 1-word battery block.
  var lengths = [17, 1];

  var pos = 5;
  var words = [];
  var i;
  var f = flags;
  for (i = 0; i < lengths.length; i++) {
    if (f & 1) {
      var block = [];
      var j;
      for (j = 0; j < lengths[i]; j++) {
        if (pos + 1 >= bytes.length) {
          return { errors: ['payload too short: truncated sensor block'] };
        }
        block.push(u16be(bytes[pos], bytes[pos + 1]));
        pos += 2;
      }
      words[i] = block;
    }
    f >>= 1;
  }

  var data = {};
  var air = {};
  var hasAir = false;
  var wind = {};
  var hasWind = false;
  var rain = {};
  var hasRain = false;

  // bit0: weather block (17 words, each offset by 32768)
  if (words[0]) {
    var w = words[0];

    // Solar radiation (W/m2) - no vocabulary key -> extra.
    data.solarRadiation = w[0] - 32768;

    // Precipitation: cumulative rainfall (upstream mm).
    rain.cumulative = round((w[1] - 32768) / 1000, 3);
    hasRain = true;

    // Lightning (count, average distance km) - no vocabulary key -> extras.
    data.lightningStrikeCount = w[2] - 32768;
    data.lightningAverageDistance = w[3] - 32768;

    // Wind speed (m/s) and direction (degrees 0..<360).
    wind.speed = round((w[4] - 32768) / 100, 2);
    wind.direction = round((w[5] - 32768) / 10, 1);
    hasWind = true;

    // Maximum wind speed (m/s) - no vocabulary key -> extra.
    data.windSpeedMax = round((w[6] - 32768) / 100, 2);

    // Air temperature (degC).
    air.temperature = round((w[7] - 32768) / 10, 1);
    hasAir = true;

    // Vapor pressure (kPa) - no vocabulary key -> extra.
    data.vaporPressure = round((w[8] - 32768) / 100, 2);

    // Atmospheric pressure (upstream kPa -> hPa).
    air.pressure = round((w[9] - 32768) / 100 * 10, 2);

    // Relative humidity (%).
    air.relativeHumidity = round((w[10] - 32768) / 10, 1);

    // Internal sensor temperature (degC) - no vocabulary key -> extra.
    data.sensorTemperatureInternal = round((w[11] - 32768) / 10, 1);

    // Tilt / orientation (degrees) and compass heading - no vocabulary key -> extras.
    data.xOrientationAngle = round((w[12] - 32768) / 10, 1);
    data.yOrientationAngle = round((w[13] - 32768) / 10, 1);
    data.compassHeading = w[14] - 32768;

    // North/East wind speed components (m/s) - no vocabulary key -> extras.
    data.windSpeedNorth = round((w[15] - 32768) / 100, 2);
    data.windSpeedEast = round((w[16] - 32768) / 100, 2);
  }

  // bit1: battery voltage (V, already volts)
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasWind) {
    data.wind = wind;
  }
  if (hasRain) {
    data.rain = rain;
  }

  return { data: data };
}
