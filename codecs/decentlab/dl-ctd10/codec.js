// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-CTD10 (water-column probe:
// pressure / liquid level, water temperature, and electrical conductivity).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-ctd10.js, attributed in
// NOTICE). Wire format is Decentlab protocol v2: version byte, 16-bit big-endian
// device id, 16-bit big-endian sensor flags bitmap, then per-flagged-sensor
// blocks of 16-bit big-endian words (LSB-first flag order).
//
// Canonical unit mapping:
//   - Water depth / level: upstream reports millimetres ((word - 32768)).
//     Normalized to water.level in METERS (/ 1000).
//   - Water temperature (degC): maps to water.temperature.current.
//   - Electrical conductivity: upstream reports microsiemens per centimetre
//     (word, as-is); maps directly to water.ec (uS/cm).
//   - Battery voltage: upstream reports volts (word / 1000); maps to `battery`.
//   - Freezing flag: no vocabulary key -> camelCase extra `freezingFlag`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
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
  // bit0: 4-word depth/temperature/conductivity/freezing block; bit1: 1-word battery block.
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

  // bit0: depth / temperature / conductivity / freezing flag (4 words)
  if (words[0]) {
    var w = words[0];

    // Water depth (upstream mm) -> water.level in METERS.
    water.level = round((w[0] - 32768) / 1000, 3);

    // Water temperature (degC) -> water.temperature.current.
    water.temperature = { current: round((w[1] - 32768) / 10, 1) };

    // Electrical conductivity (uS/cm, as-is) -> water.ec.
    water.ec = w[2];

    hasWater = true;

    // Freezing flag - no vocabulary key -> camelCase extra.
    data.freezingFlag = w[3];
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-ctd10";
  }
  return result;
}
