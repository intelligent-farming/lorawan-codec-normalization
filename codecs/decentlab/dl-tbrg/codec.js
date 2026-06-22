// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-TBRG (Tipping Bucket Rain Gauge:
// cumulative rainfall plus per-interval precipitation and tip count).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit device id, 16-bit sensor
// flags bitmap, then per-flagged-sensor blocks of 16-bit big-endian words)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-tbrg-01.js, attributed
// in NOTICE).
//
// The gauge resolution is 0.1 mm per bucket tip. The cumulative precipitation
// register is a 32-bit tip count (low word + high word * 65536); multiplying by
// the 0.1 mm resolution gives cumulative rainfall, mapped to the vocabulary's
// `rain.cumulative`. The same raw 32-bit count is the genuine bucket tip count,
// emitted as the camelCase extra `tipCount`. Upstream reports no rain rate
// field, so `rain.intensity` is not produced; the per-interval precipitation
// amount (mm) and the measurement interval (s) are emitted as camelCase extras
// (`intervalPrecipitation`, `precipitationIntervalSeconds`). Decentlab reports
// "Battery voltage" already in volts, so it maps directly to `battery`.

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

  // Resolution: 0.1 mm per tip (upstream PARAMETERS.resolution).
  var RESOLUTION = 0.1;

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table.
  // bit0: 4-word precipitation block; bit1: 1-word battery block.
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
  var rain = {};
  var hasRain = false;

  // bit0: precipitation block (4 words).
  if (words[0]) {
    var w = words[0];

    // Per-interval precipitation (mm) - no vocabulary key -> extra.
    data.intervalPrecipitation = round(w[0] * RESOLUTION, 1);

    // Measurement interval (s) - no vocabulary key -> extra.
    data.precipitationIntervalSeconds = w[1];

    // Cumulative tip count (32-bit: low word + high word * 65536).
    var tipCount = w[2] + w[3] * 65536;

    // Raw bucket tip count - no vocabulary key -> extra.
    data.tipCount = tipCount;

    // Cumulative rainfall (mm).
    rain.cumulative = round(tipCount * RESOLUTION, 1);
    hasRain = true;
  }

  // bit1: battery voltage (V, already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasRain) {
    data.rain = rain;
  }

  return { data: data };
}
