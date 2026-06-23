// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-PR36CTD (high-precision pressure /
// liquid-level, temperature and electrical-conductivity profiling probe for
// boreholes, wells and piezometers).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-pr36ctd-8192-1024.js,
// attributed in NOTICE). Wire format is Decentlab protocol v2: version byte,
// 16-bit big-endian device id, 16-bit big-endian sensor flags bitmap, then
// per-flagged-sensor blocks of 16-bit big-endian words (LSB-first flag order).
//
// Unit normalization to the shared vocabulary:
//   - Hydrostatic pressure: upstream (x - 32768) / kp gives bar; converted to
//     kPa (x100) for water.pressure.
//   - PT1000 (water) temperature: degC, maps to water.temperature.current.
//   - Electrical conductivity: upstream (x - 32768) / kec gives mS/cm; converted
//     to µS/cm (x1000) for water.ec.
//   - Battery voltage: already volts, maps directly to `battery`.
//   - Electronics temperature is a diagnostic the vocabulary does not model and
//     is emitted as the camelCase extra `electronicsTemperature`.

// device-specific calibration parameters (kp/kec from the -8192-1024 variant)
var KP = 8192;
var KEC = 1024;

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
  // bit0: 4-word pressure/temperature/conductivity block; bit1: 1-word battery.
  var lengths = [4, 1];

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
  var water = {};
  var hasWater = false;

  // bit0: pressure / electronics temp / PT1000 temp / conductivity (4 words)
  if (words[0]) {
    var w = words[0];

    // Hydrostatic pressure: (x - 32768) / kp -> bar; x100 -> kPa.
    water.pressure = round(((w[0] - 32768) / KP) * 100, 4);

    // Electronics temperature (degC): diagnostic -> camelCase extra.
    data.electronicsTemperature = round((w[1] - 32768) / 256, 4);

    // PT1000 (water) temperature (degC) -> water.temperature.current.
    water.temperature = { current: round((w[2] - 32768) / 256, 4) };

    // Electrical conductivity: (x - 32768) / kec -> mS/cm; x1000 -> µS/cm.
    water.ec = round(((w[3] - 32768) / KEC) * 1000, 4);

    hasWater = true;
  }

  // bit1: battery voltage (V, already volts)
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasWater) {
    data.water = water;
  }

  return { data: data };
}
