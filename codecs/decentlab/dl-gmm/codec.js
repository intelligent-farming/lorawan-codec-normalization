// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-GMM (Greenhouse Multi Monitor for
// LoRaWAN): photosynthetically active radiation, air temperature, humidity,
// CO2, atmospheric pressure, vapor pressure deficit and dew point.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit device id, 16-bit sensor
// flags bitmap, then per-flagged-sensor blocks of 16-bit big-endian words)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-gmm.js, attributed in
// NOTICE).
//
// Decentlab reports "Battery voltage" already in volts, so it maps directly to
// the vocabulary's `battery` field. Atmospheric pressure is reported in kPa;
// the vocabulary's `air.pressure` is hPa, so it is multiplied by 10. The
// remaining sensor readings the vocabulary does not model are emitted as
// camelCase extras: photosynthetically active radiation is µmol⋅m⁻²⋅s⁻¹ (not
// lux, so it is NOT mapped to air.lightIntensity), and vapor pressure deficit
// (kPa) and dew point (°C) have no vocabulary key.

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
  var lengths = [7, 1];

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

  // bit0: greenhouse multi-sensor block (7 words)
  if (words[0]) {
    var w = words[0];

    // Photosynthetically active radiation (µmol⋅m⁻²⋅s⁻¹) — not lux, so it is an
    // extra rather than air.lightIntensity.
    data.photosyntheticallyActiveRadiation = round((w[0] - 32768) / 10, 1);

    air.temperature = round((w[1] - 32768) / 100, 2);
    air.relativeHumidity = round((w[2] - 32768) / 10, 1);
    air.co2 = w[3] - 32768;

    // Atmospheric pressure: upstream kPa -> vocabulary hPa.
    air.pressure = round((w[4] - 32768) / 100 * 10, 2);
    hasAir = true;

    // Vapor pressure deficit (kPa) and dew point (°C) — no vocabulary key.
    data.vaporPressureDeficit = round((w[5] - 32768) / 100, 2);
    data.dewPoint = round((w[6] - 32768) / 100, 2);
  }

  // bit1: battery voltage (V, already volts)
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
