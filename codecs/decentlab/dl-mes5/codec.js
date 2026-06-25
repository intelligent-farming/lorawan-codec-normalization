// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-MES5 (large-range optical turbidity
// and temperature sensor for waste-water / sludge applications).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-mes5.js, attributed in
// NOTICE). Wire format is Decentlab protocol v2: version byte, 16-bit big-endian
// device id, 16-bit big-endian sensor flags bitmap, then per-flagged-sensor
// blocks of 16-bit big-endian words (LSB-first flag order).
//
// Canonical unit mapping:
//   - Temperature: upstream (word - 32768) / 100 degC -> water.temperature.current.
//   - Turbidity: upstream word / 10 FAU. FAU (formazin attenuation units) is the
//     same formazin-referenced turbidity scale as NTU (1 FAU = 1 NTU) -> water.turbidity (NTU).
//   - Battery voltage: upstream word / 1000 volts -> `battery`.
//   - Status word: device diagnostic, no vocabulary key -> extra `status`.
//   - Sludge blanket (%): no vocabulary key -> extra `sludgeBlanket`.
//   - Suspended solid (g/L): no vocabulary key -> extra `suspendedSolids`.

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
  // bit0: 5-word status/temperature/sludge/suspended/turbidity block;
  // bit1: 1-word battery block.
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

  // bit0: status / temperature / sludge blanket / suspended solid / turbidity (5 words)
  if (words[0]) {
    var w = words[0];

    // Status word - device diagnostic, no vocabulary key -> extra.
    data.status = w[0];

    // Temperature (degC) -> water.temperature.current.
    water.temperature = { current: round((w[1] - 32768) / 100, 2) };

    // Turbidity (FAU == NTU) -> water.turbidity.
    water.turbidity = round(w[4] / 10, 1);

    hasWater = true;

    // Sludge blanket (%) - no vocabulary key -> extra.
    data.sludgeBlanket = round(w[2] / 100, 2);

    // Suspended solid (g/L) - no vocabulary key -> extra.
    data.suspendedSolids = round(w[3] / 100, 2);
  }

  // bit1: battery voltage (already volts) -> `battery`.
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
    result.data.model = "dl-mes5";
  }
  return result;
}
