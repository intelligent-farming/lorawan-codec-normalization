// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-TRS21 (Soil Water Potential and
// Temperature Sensor for LoRaWAN; METER TEROS 21 probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-trs21.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: soil_temperature (°C, upstream (word - 32768) / 10) ->
// soil.temperature; battery_voltage (already volts, word / 1000) -> battery.
// Water potential (kPa, upstream -(word / 10)) has no vocabulary key (the
// vocabulary models neither soil water potential nor matric tension), so it is
// emitted as the camelCase extra `soilWaterPotential` in kPa, faithful to the
// upstream sign and scale.

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
  // upstream SENSORS table:
  //   bit0 soil probe (2 words: water potential, soil temperature)
  //   bit1 battery (1 word)
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
  var soil = {};
  var hasSoil = false;

  // bit0: soil probe. Word 0 -> water potential (kPa), word 1 -> temperature.
  if (words[0]) {
    // Water potential: upstream -(word / 10) kPa. Not modeled by the
    // vocabulary -> camelCase extra (kPa, sign and scale preserved).
    data.soilWaterPotential = round(-(words[0][0] / 10), 1);

    // Soil temperature (°C), signed via upstream's (word - 32768) / 10.
    soil.temperature = round((words[0][1] - 32768) / 10, 1);
    hasSoil = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasSoil) {
    data.soil = soil;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-trs21";
  }
  return result;
}
