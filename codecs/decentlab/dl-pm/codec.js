// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-PM (Particulate Matter,
// Temperature, Humidity and Barometric Pressure Sensor for LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit device id, 16-bit sensor
// flags bitmap, then per-flagged-sensor blocks of 16-bit big-endian words)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-pm.js, attributed in
// NOTICE). The normalization is authored here; upstream normalizeUplink is not
// copied.
//
// Mapping notes:
// - Air temperature (°C) and relative humidity (%) map directly to
//   `air.temperature` / `air.relativeHumidity`.
// - Barometric pressure is reported in Pa (word * 2); `air.pressure` is hPa, so
//   it is divided by 100. This is true atmospheric pressure (~900-1100 hPa).
// - Battery voltage is already in volts, so it maps directly to `battery`.
// - Particulate-matter mass concentrations (µg/m³), number concentrations
//   (1/cm³) and typical particle size (nm) are not modelled by the vocabulary,
//   so they are emitted as camelCase extras (`pm1`, `pm2_5`, `pm4`, `pm10`,
//   the `*NumberConcentration` counts, and `typicalParticleSize`).

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
  var lengths = [1, 10, 2, 1];

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

  // bit0: battery voltage (V, already volts)
  if (words[0]) {
    data.battery = round(words[0][0] / 1000, 3);
  }

  // bit1: particulate-matter mass concentrations (µg/m³), typical particle
  // size (nm) and number concentrations (1/cm³) -> camelCase extras.
  if (words[1]) {
    var pm = words[1];
    data.pm1 = round(pm[0] / 10, 1);
    data.pm2_5 = round(pm[1] / 10, 1);
    data.pm4 = round(pm[2] / 10, 1);
    data.pm10 = round(pm[3] / 10, 1);
    data.typicalParticleSize = pm[4];
    data.pm0_5NumberConcentration = round(pm[5] / 10, 1);
    data.pm1NumberConcentration = round(pm[6] / 10, 1);
    data.pm2_5NumberConcentration = round(pm[7] / 10, 1);
    data.pm4NumberConcentration = round(pm[8] / 10, 1);
    data.pm10NumberConcentration = round(pm[9] / 10, 1);
  }

  // bit2: air temperature (°C) and relative humidity (%)
  if (words[2]) {
    air.temperature = round(175.72 * words[2][0] / 65536 - 46.85, 2);
    air.relativeHumidity = round(125 * words[2][1] / 65536 - 6, 2);
    hasAir = true;
  }

  // bit3: barometric pressure (upstream Pa = word * 2 -> hPa)
  if (words[3]) {
    air.pressure = round(words[3][0] * 2 / 100, 2);
    hasAir = true;
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
