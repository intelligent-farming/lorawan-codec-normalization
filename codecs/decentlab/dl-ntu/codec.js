// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-NTU (optical turbidity and
// temperature sensor for water-quality monitoring).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-ntu.js, attributed in
// NOTICE). Wire format is Decentlab protocol v2: version byte, 16-bit big-endian
// device id, 16-bit big-endian sensor flags bitmap, then per-flagged-sensor
// blocks of 16-bit big-endian words (LSB-first flag order).
//
// Canonical unit mapping:
//   - Water temperature (degC): upstream (word - 32768) / 100 -> water.temperature.current.
//   - Turbidity in NTU: upstream word / 10 (NTU); maps directly to water.turbidity (NTU).
//   - Turbidity in FNU: upstream word / 10; no vocabulary key -> camelCase extra turbidityFnu.
//   - Turbidity in mg/L: upstream word / 10; no vocabulary key -> camelCase extra turbidityMgL.
//   - Status byte: no vocabulary key -> camelCase extra status.
//   - Battery voltage: upstream word / 1000 (volts); maps to `battery`.

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
  // bit0: 5-word status/temperature/turbidity block; bit1: 1-word battery block.
  var lengths = [5, 1];

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

  // bit0: status / temperature / turbidity (NTU / FNU / mg/L) (5 words)
  if (words[0]) {
    var w = words[0];

    // Status byte - no vocabulary key -> camelCase extra.
    data.status = w[0];

    // Water temperature (degC) -> water.temperature.current.
    water.temperature = { current: round((w[1] - 32768) / 100, 2) };

    // Turbidity in NTU -> water.turbidity (NTU is the vocabulary unit).
    water.turbidity = round(w[2] / 10, 1);

    hasWater = true;

    // FNU / mg/L turbidity - no vocabulary key -> camelCase extras.
    data.turbidityFnu = round(w[3] / 10, 1);
    data.turbidityMgL = round(w[4] / 10, 1);
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
    result.data.model = "dl-ntu";
  }
  return result;
}
