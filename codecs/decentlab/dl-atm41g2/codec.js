// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-ATM41 G2 (Eleven Parameter Weather
// Station: solar radiation, precipitation, lightning, wind, air temperature,
// vapor/barometric pressure, humidity, tilt and battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-atm41g2.js,
// attributed in NOTICE). Do NOT copy upstream normalizeUplink.
//
// Two sensor blocks (flag-bit order, LSB first):
//   bit0: 17-word weather block
//   bit1: 1-word battery block
//
// Unit normalization to the shared vocabulary:
//   - air.temperature (°C): upstream °C, mapped directly.
//   - air.relativeHumidity (%): upstream %, mapped directly.
//   - air.pressure (hPa): upstream barometric pressure is kPa -> x10.
//   - wind.speed (m/s) / wind.direction (deg): upstream units, direct.
//   - rain.cumulative (mm): upstream cumulative precipitation, direct.
//   - rain.intensity (mm/hour): upstream per-interval precipitation channel,
//     reported by the device in mm; mapped to the intensity channel directly.
//   - battery (V): upstream volts, direct.
// Channels the vocabulary does not model (solar radiation W/m2, lightning
// count/distance, max wind speed, vapor pressure, internal temperature, tilt,
// precipitation electrical conductivity) are emitted as camelCase extras.

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
  // upstream SENSORS table: bit0 weather (17 words), bit1 battery (1 word).
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

  // bit0: 17-word weather block
  if (words[0]) {
    var x = words[0];
    var air = {};
    var wind = {};
    var rain = {};

    // Vocabulary-mapped channels.
    air.temperature = round((x[7] - 32768) / 10, 2);
    air.relativeHumidity = round((x[10] - 32768) / 10, 2);
    // Upstream barometric pressure is kPa; vocabulary air.pressure is hPa.
    air.pressure = round(((x[9] - 32768) / 100) * 10, 2);

    wind.speed = round((x[4] - 32768) / 100, 2);
    wind.direction = round((x[5] - 32768) / 10, 2);

    rain.intensity = round(x[1] / 1000, 3);
    rain.cumulative = round((x[15] + x[16] * 65536) / 1000, 3);

    data.air = air;
    data.wind = wind;
    data.rain = rain;

    // Extras: channels the vocabulary does not model.
    data.solarRadiation = round((x[0] - 32768) / 10, 2);
    data.lightningStrikeCount = x[2] - 32768;
    data.lightningAverageDistance = x[3] - 32768;
    data.maxWindSpeed = round((x[6] - 32768) / 100, 2);
    data.vaporPressure = round((x[8] - 32768) / 100, 2);
    data.internalTemperature = round((x[11] - 32768) / 10, 2);
    data.tiltAngleX = round((x[12] - 32768) / 10, 2);
    data.tiltAngleY = round((x[13] - 32768) / 10, 2);
    data.precipitationElectricalConductivity = x[14] - 32768;
  }

  // bit1: 1-word battery block (volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  return { data: data };
}
