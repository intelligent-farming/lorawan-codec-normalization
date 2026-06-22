// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-TRS11 (METER TEROS soil moisture,
// temperature and electrical conductivity sensor for LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported faithfully from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-trs11.js,
// attributed in NOTICE). The per-sensor conversion formulas below are ported
// verbatim from the upstream SENSORS table; the results are then mapped onto
// the shared normalized vocabulary.
//
// Mapping:
//   - volumetric_water_content: the upstream raw count is converted to
//     volumetric water content in m³⋅m⁻³ (a 0..1 fraction) via the upstream
//     calibration. m³⋅m⁻³ * 100 is volumetric water content as a percentage,
//     which is exactly the vocabulary's `soil.moisture` (%). So a genuine VWC
//     percentage IS produced, and it maps to soil.moisture.
//   - soil_temperature (°C) -> soil.temperature (°C).
//   - battery_voltage (already volts) -> battery (V).
//   - dielectric_permittivity is the raw relative permittivity (dimensionless),
//     not modelled by the vocabulary, so it is emitted as the camelCase extra
//     `dielectricPermittivity`. The Decentlab protocol header fields
//     (protocol_version, device_id) are emitted as camelCase extras too.
//
// Note: despite the product name, the upstream DL-TRS11 decoder does not decode
// an electrical-conductivity channel (the TRS11 transmits permittivity, VWC and
// temperature only), so no soil.ec is produced here.

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

  var deviceId = u16be(bytes[1], bytes[2]);
  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table:
  //   bit0 permittivity/VWC/temperature (2 words), bit1 battery (1 word)
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
  data.protocolVersion = version;
  data.deviceId = deviceId;

  var soil = {};
  var hasSoil = false;

  // bit0: dielectric permittivity (raw), volumetric water content, soil temp.
  if (words[0]) {
    var x0 = words[0][0];
    var x1 = words[0][1];

    // Upstream dielectric_permittivity convert(): a polynomial in (x0/10),
    // squared. Dimensionless relative permittivity -> camelCase extra.
    var perm = Math.pow(
      0.000000002887 * Math.pow(x0 / 10, 3) -
        0.0000208 * Math.pow(x0 / 10, 2) +
        0.05276 * (x0 / 10) -
        43.39,
      2
    );
    data.dielectricPermittivity = round(perm, 4);

    // Upstream volumetric_water_content convert(): m³⋅m⁻³ (0..1 fraction).
    // * 100 -> volumetric water content as a percentage -> soil.moisture (%).
    var vwc = (x0 / 10) * 0.0003879 - 0.6956;
    soil.moisture = round(vwc * 100, 3);

    // Upstream soil_temperature convert(): (x1 - 32768) / 10, °C.
    soil.temperature = round((x1 - 32768) / 10, 1);
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
