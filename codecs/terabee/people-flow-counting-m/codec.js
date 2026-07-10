// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Terabee People Flow Counting M: an overhead
// time-of-flight bidirectional pedestrian counter. Its counting-data uplink
// carries cumulative directional in/out counts and a status-flag byte.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/terabee/people-flow-counting-m.js,
// attributed in NOTICE). This module re-authors the JSON to the normalized
// vocabulary and never copies the upstream output. (The upstream uint32 helper
// is numerically buggy — `integer += integer*255 + b` — so we implement a plain
// big-endian reader here.)
//
// Only the counting-data uplink on FPort 82 is a measurement. All other FPorts
// carry command/parameter responses (mounting height, versions, etc.) and are
// reported as errors.
//
// Field mapping (FPort 82, 9-byte frame):
//   count_in  (bytes[0..3], big-endian u32) -> countInTotal  (cumulative extra)
//   count_out (bytes[4..7], big-endian u32) -> countOutTotal (cumulative extra)
//   people.total = count_in - count_out     -> people.total  (cumulative net)
//   flags byte[8]: bit0 TPC_STOPPED, bit1 TPC_STUCK, bit2 NETWORK_ON
//     -> tpcStopped / tpcStuck / networkOn (boolean extras)
//
// people.total semantics: the device reports cumulative directional totals, not
// per-interval deltas, so the cumulative net (in - out) maps to people.total and
// the raw cumulative counts are preserved as extras.

function u32be(bytes, offset) {
  return (
    bytes[offset] * 16777216 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 82) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 82 counting-data uplink)'] };
  }
  if (!bytes || bytes.length < 9) {
    return { errors: ['counting-data frame too short (expected 9 bytes)'] };
  }

  var countIn = u32be(bytes, 0);
  var countOut = u32be(bytes, 4);
  var flags = bytes[8];

  var data = {};
  data.people = { total: countIn - countOut };
  data.countInTotal = countIn;
  data.countOutTotal = countOut;
  data.tpcStopped = Boolean(flags & 0x01);
  data.tpcStuck = Boolean(flags & 0x02);
  data.networkOn = Boolean(flags & 0x04);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "terabee";
    result.data.model = "people-flow-counting-m";
  }
  return result;
}
