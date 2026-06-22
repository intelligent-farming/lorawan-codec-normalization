// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-5TM (METER 5TM soil moisture
// (volumetric water content) and soil temperature probe for LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-5tm.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Sensor block layout (flag-bit order, LSB first), from the upstream SENSORS
// table:
//   bit0: soil sensor, 2 words:
//         word0 -> dielectric permittivity (raw / 50)
//               -> volumetric water content via the device's cubic (Topp-style)
//                  calibration, in m3/m3 (a fraction)
//         word1 -> soil temperature, (raw - 400) / 10 in degC
//   bit1: battery, 1 word: voltage = raw / 1000 (already volts)
//
// Mapping: volumetric water content is a genuine VWC fraction (m3/m3); it is
// multiplied by 100 to the vocabulary's `soil.moisture` percent. The dielectric
// permittivity is the underlying raw measurand the vocabulary does not model,
// so it is kept as the camelCase extra `dielectricPermittivity`. Soil
// temperature -> soil.temperature (degC). Battery voltage (already volts) ->
// battery (V). The protocol device id is emitted as the extra `deviceId`.

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
  // upstream SENSORS table.
  var lengths = [2, 1];

  var pos = 5;
  var words = [];
  var i;
  var j;
  var f = flags;
  for (i = 0; i < lengths.length; i++) {
    if (f & 1) {
      var block = [];
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

  var data = { deviceId: deviceId };
  var soil = {};
  var hasSoil = false;

  // bit0: soil sensor (dielectric permittivity + VWC + soil temperature)
  if (words[0]) {
    var permittivity = words[0][0] / 50;
    data.dielectricPermittivity = round(permittivity, 2);

    // Device cubic calibration -> volumetric water content in m3/m3 (fraction).
    var vwcFraction =
      0.0000043 * Math.pow(permittivity, 3) -
      0.00055 * Math.pow(permittivity, 2) +
      0.0292 * permittivity -
      0.053;
    // m3/m3 fraction -> percent for the vocabulary's soil.moisture.
    soil.moisture = round(vwcFraction * 100, 2);

    soil.temperature = round((words[0][1] - 400) / 10, 1);
    hasSoil = true;
  }

  // bit1: battery voltage (already volts)
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasSoil) {
    data.soil = soil;
  }

  return { data: data };
}
