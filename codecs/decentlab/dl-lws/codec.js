// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-LWS (Leaf Wetness Sensor for
// LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-lws.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: leaf_wetness_index = ((w0 + w1*65536) / 8388608 - 1) is the sensor's
// normalized leaf-wetness signal (0 dry .. 1 fully wet). The category vocabulary
// models leaf.wetness as a percentage (0-100), so we scale the index by 100 and
// clamp it to [0,100]; a clamp emits a warning and the raw index is preserved as
// the camelCase extra leafWetnessIndex. battery_voltage (already volts) ->
// battery.

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
  // upstream SENSORS table: bit0 leaf wetness (2 words), bit1 battery (1 word).
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
  var leaf = {};
  var hasLeaf = false;
  var warnings = [];

  // bit0: leaf wetness index. Upstream: (x[0] + x[1]*65536) / 8388608 - 1.
  if (words[0]) {
    var index = (words[0][0] + words[0][1] * 65536) / 8388608 - 1;
    var pct = index * 100;
    if (pct < 0) {
      pct = 0;
      warnings.push('leaf wetness index below 0; clamped to 0%');
    } else if (pct > 100) {
      pct = 100;
      warnings.push('leaf wetness index above 1; clamped to 100%');
    }
    leaf.wetness = round(pct, 2);
    data.leafWetnessIndex = round(index, 6);
    hasLeaf = true;
  }

  // bit1: battery voltage (V, already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasLeaf) {
    data.leaf = leaf;
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
    result.data.model = "dl-lws";
  }
  return result;
}
