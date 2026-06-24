// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-PR21 (submersible piezoresistive
// pressure / liquid-level and temperature probe with G1/4" pipe thread for
// LoRaWAN). Despite reporting a "pressure", this is a water-column probe (vendor
// product page: "pressure / liquid level and temperature sensor"), not an
// atmospheric barometer: the upstream pressure transfer function spans a
// configurable hydrostatic range Pmin..Pmax in BAR (-1.0..10.0 bar on the -1-10
// variant), so the reading is hydrostatic liquid pressure, mapped to
// water.pressure (groundwater category) — never to air.pressure (atmospheric,
// 900-1100 hPa).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-pr21-1-10.js, attributed
// in NOTICE). Wire format is Decentlab protocol v2: version byte, 16-bit
// big-endian device id, 16-bit big-endian sensor flags bitmap, then
// per-flagged-sensor blocks of 16-bit big-endian words (LSB-first flag order).
//
// Unit normalization to the shared vocabulary (matching sibling dl-pr26):
//   - Hydrostatic pressure: upstream (x - 16384) / 32768 * (Pmax - Pmin) + Pmin
//     gives bar; converted to kPa (x100) for water.pressure. The -1-10 variant
//     can read negative (sub-atmospheric); water.pressure has a vocabulary
//     minimum of 0, so a negative reading is surfaced as the camelCase extra
//     `waterPressureKpa` with a warning instead of an out-of-bounds water.pressure.
//   - Probe temperature: upstream (x - 384) * 0.003125 - 50 gives degC, maps to
//     water.temperature.current.
//   - Battery voltage: already volts (x / 1000), maps directly to `battery`.

// device-specific pressure range (bar) from the -1-10 variant
var PMIN = -1.0;
var PMAX = 10.0;

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
  // bit0: 2-word pressure/temperature block; bit1: 1-word battery.
  var lengths = [2, 1];

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
  var warnings = [];
  var hasWater = false;

  // bit0: hydrostatic pressure + probe temperature (2 words)
  if (words[0]) {
    var w = words[0];

    // Hydrostatic pressure: (x - 16384) / 32768 * (Pmax - Pmin) + Pmin -> bar;
    // x100 -> kPa.
    var bar = (w[0] - 16384) / 32768 * (PMAX - PMIN) + PMIN;
    var kpa = round(bar * 100, 4);
    if (kpa < 0) {
      // Sub-atmospheric/vacuum reading: water.pressure must be >= 0, so surface
      // the raw value as a camelCase extra and warn instead of emitting an
      // out-of-bounds water.pressure.
      data.waterPressureKpa = kpa;
      warnings.push('hydrostatic pressure ' + kpa + ' kPa is negative (sub-atmospheric); reported as waterPressureKpa');
    } else {
      water.pressure = kpa;
    }

    // Probe temperature (degC) -> water.temperature.current.
    water.temperature = { current: round((w[1] - 384) * 0.003125 - 50, 4) };
    hasWater = true;
  }

  // bit1: battery voltage (V, already volts)
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasWater) {
    data.water = water;
  }

  var result = { data: data };
  if (warnings.length) {
    result.warnings = warnings;
  }
  return result;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-pr21";
  }
  return result;
}
