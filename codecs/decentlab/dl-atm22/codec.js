// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-ATM22 (METER ATMOS 22 ultrasonic
// anemometer: wind speed, wind direction, maximum wind speed (gust), air
// temperature, sensor orientation, and north/east wind speed components).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-atm22.js, attributed in
// NOTICE). Wire format is Decentlab protocol v2: version byte, 16-bit big-endian
// device id, 16-bit big-endian sensor flags bitmap, then per-flagged-sensor
// blocks of 16-bit big-endian words (LSB-first flag order).
//
// Decentlab reports "Battery voltage" already in volts, so it maps directly to
// the vocabulary's `battery` field. Wind speed (m/s) and direction (degrees)
// map to wind.speed / wind.direction; direction is wrapped to 0..<360. Maximum
// wind speed maps to the camelCase extra `windGust`. Air temperature maps to
// air.temperature. Sensor readings the vocabulary does not model (X/Y
// orientation angle, north/east wind speed components) are emitted as camelCase
// extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function wrapDirection(deg) {
  var d = deg % 360;
  if (d < 0) {
    d += 360;
  }
  return d;
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
  // bit0: 8-word wind/temperature block; bit1: 1-word battery block.
  var lengths = [8, 1];

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

  // bit0: wind/temperature block (8 words, each offset by 32768)
  if (words[0]) {
    var w = words[0];

    // Wind speed (m/s) and direction (degrees, wrapped to 0..<360).
    wind.speed = round((w[0] - 32768) / 100, 2);
    wind.direction = round(wrapDirection((w[1] - 32768) / 10), 1);
    hasWind = true;

    // Maximum wind speed / gust (m/s) - no vocabulary key -> extra.
    data.windGust = round((w[2] - 32768) / 100, 2);

    // Air temperature (degC).
    air.temperature = round((w[3] - 32768) / 10, 1);
    hasAir = true;

    // X/Y orientation angle (degrees) - no vocabulary key -> extras.
    data.xOrientationAngle = round((w[4] - 32768) / 10, 1);
    data.yOrientationAngle = round((w[5] - 32768) / 10, 1);

    // North/East wind speed components (m/s) - no vocabulary key -> extras.
    data.windSpeedNorth = round((w[6] - 32768) / 100, 2);
    data.windSpeedEast = round((w[7] - 32768) / 100, 2);
  }

  // bit1: battery voltage (V, already volts)
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasWind) {
    data.wind = wind;
  }
  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
