// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-ZN1 (Dendrometer for LoRaWAN): a
// ratiometric linear-position dendrometer tracking stem/trunk dimensional
// change for growth and water-stress monitoring. The primary measurement is a
// dimensional change reported directly in µm, so this device maps to the
// `dendrometer` category (`plant.dendrometer` in µm).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported faithfully from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-zn1.js,
// attributed in NOTICE). The per-sensor conversion formulas below are ported
// verbatim from the upstream SENSORS table; the results are then mapped onto
// the shared normalized vocabulary. Upstream normalizeUplink is NOT copied.
//
// Mapping (flag bit order, LSB first):
//   bit0 dendrometer block (2 words, x[0]/x[1] form a 24-bit ratiometric
//     count): upstream dendrometer_position =
//       ((x[0] + x[1]*65536) / 8388608 - 1) * 20000  -> µm (already µm).
//     Mapped directly to `plant.dendrometer`.
//   bit1 battery (1 word): x[0] / 1000 -> V -> `battery`.
// Protocol header fields are emitted as the extras protocolVersion / deviceId.

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

  var deviceId = u16be(bytes[1], bytes[2]);
  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first):
  //   bit0 dendrometer (2 words), bit1 battery (1 word).
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

  var hasDendrometer = false;

  // bit0: ratiometric dendrometer position (already µm).
  if (words[0]) {
    var x0 = words[0][0];
    var x1 = words[0][1];
    var position = ((x0 + x1 * 65536) / 8388608 - 1) * 20000;
    data.plant = { dendrometer: round(position, 2) };
    hasDendrometer = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (!hasDendrometer) {
    return { errors: ['no dendrometer field in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "decentlab", model: "dl-zn1" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-zn1";
  }
  return result;
}
