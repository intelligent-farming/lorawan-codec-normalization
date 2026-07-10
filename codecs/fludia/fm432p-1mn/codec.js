// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for fludia/fm432p-1mn (Pulse Multifluid Tracker, 1 min).
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/fludia/fm432p-1mn-decode.js,
// attributed in NOTICE). Normalization authored here; the upstream flat
// `index`/`increments` bag is NOT copied.
//
// The FM432p is a dry-contact pulse reader for a gas/water/heat meter. It is
// the pulse-counting sibling of the fludia/fm432t-1mn temperature datalogger
// (same T1/T2 datalog header scheme). Frames are dispatched by the leading
// header byte, not by fPort:
//   T1_1MN (0x5c, 44 bytes): datalog frame. bytes[1..3] = 24-bit big-endian
//     cumulative meter index (pulses), followed by 20 big-endian 16-bit
//     per-minute pulse increments (bytes[4..43]).
//   T2     (0x29, 10 bytes): statistics frame. bytes[4..7] = 32-bit big-endian
//     cumulative index; no per-interval samples.
//   START  (0x01, 3 bytes): device start notification -- not telemetry.
//
// Normalization (the metered quantity is defined by the attached meter, not
// this counter, so it maps to the generic pulse vocabulary):
//   cumulative index          -> pulse.total (cumulative pulse count)
//   most recent 1-min sample  -> pulse.count (pulses in the reporting interval)
// The datalog carries no absolute timestamps, so per-sample RFC3339 history
// cannot be reconstructed; the full increment array is exposed as an extra.

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  var header = bytes[0];

  // T1 datalog frame (0x5c, 44 bytes, 24-bit index + 20 samples).
  if (header === 0x5c) {
    if (bytes.length !== 44) {
      return { errors: ['invalid T1 datalog length ' + bytes.length + ' (expected 44)'] };
    }
    var total = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    var samples = [];
    for (var i = 0; i < 20; i++) {
      samples.push(u16be(bytes[4 + 2 * i], bytes[5 + 2 * i]));
    }
    var data = {};
    data.pulse = { total: total, count: samples[samples.length - 1] };
    data.increments = samples;
    return { data: data };
  }

  // T2 statistics frame (0x29, 10 bytes): 32-bit cumulative index, no samples.
  if (header === 0x29) {
    if (bytes.length !== 10) {
      return { errors: ['invalid T2 length ' + bytes.length + ' (expected 10)'] };
    }
    var t2total = (bytes[4] * 0x1000000) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];
    return { data: { pulse: { total: t2total } } };
  }

  if (header === 0x01) {
    return { errors: ['unsupported frame type 0x01 (START notification, not telemetry)'] };
  }
  return { errors: ['unknown frame header 0x' + header.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "fludia";
    result.data.model = "fm432p-1mn";
  }
  return result;
}
