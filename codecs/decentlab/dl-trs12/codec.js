// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-TRS12 (Soil Moisture, Temperature
// and Electrical Conductivity Sensor for LoRaWAN; METER TEROS 12 probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-trs12.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: the TEROS 12 reports volumetric water content as a fraction
// (m³⋅m⁻³); the vocabulary's `soil.moisture` is a percentage, so VWC is
// multiplied by 100. soil_temperature (°C) -> soil.temperature;
// electrical_conductivity (upstream µS⋅cm⁻¹) -> soil.ec (dS/m, /1000);
// battery_voltage (already volts) -> battery. The raw dielectric permittivity
// (a derived quantity the vocabulary does not model) is emitted as the
// camelCase extra `dielectricPermittivity`.

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
  //   bit0 soil probe (3 words), bit1 battery (1 word)
  var lengths = [3, 1];

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

  // bit0: soil probe. Three 16-bit words feed four derived values.
  if (words[0]) {
    var raw = words[0][0];
    var t = raw / 10;

    // Dielectric permittivity (derived; not in vocabulary) -> camelCase extra.
    var permittivity = Math.pow(
      0.000000002887 * Math.pow(t, 3) -
        0.0000208 * Math.pow(t, 2) +
        0.05276 * t -
        43.39,
      2
    );
    data.dielectricPermittivity = round(permittivity, 4);

    // Volumetric water content: upstream m³⋅m⁻³ fraction (raw/10 * k - b) ->
    // percentage (×100).
    var vwc = (raw / 10) * 0.0003879 - 0.6956;
    soil.moisture = round(vwc * 100, 4);

    // Soil temperature (°C), signed via upstream's (word - 32768) / 10.
    soil.temperature = round((words[0][1] - 32768) / 10, 1);

    // Electrical conductivity: upstream µS⋅cm⁻¹ -> dS/m (/1000).
    soil.ec = round(words[0][2] / 1000, 3);

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
    result.data.model = "dl-trs12";
  }
  return result;
}
