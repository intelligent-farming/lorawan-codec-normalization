// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for fludia/fm432p-10-15mn (Pulse Multifluid Tracker,
// 10/15 min datalog step).
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/fludia/fm432p-10-15mn-decode.js,
// attributed in NOTICE). Normalization authored here; the upstream flat
// `index`/`increments` bag is NOT copied.
//
// The FM432p is a dry-contact pulse reader for a gas/water/heat meter (same
// T1/T2 datalog scheme as fludia/fm432t-1mn / fm432p-1mn). This firmware emits
// coarser datalog steps, dispatched by the leading header byte (not fPort):
//   T1 fixed step (20 bytes): header selects the step --
//     0x2b = 10 min, 0x2c = 15 min, 0x2d = 60 min. bytes[1..3] = 24-bit
//     big-endian cumulative meter index, then 8 big-endian 16-bit per-step
//     pulse increments (bytes[4..19]).
//   T1 adjustable step (0x6b, 8..46 bytes): bytes[1] = step (minutes),
//     bytes[2..5] = 32-bit big-endian index, then N 16-bit increments.
//   T2 (0x29, 10 bytes): statistics frame. bytes[4..7] = 32-bit big-endian
//     cumulative index; bytes[9] = step. No per-interval samples.
//   START (0x01, 3 bytes): device start notification -- not telemetry.
//
// Normalization (metered quantity defined by the attached meter -> generic
// pulse vocabulary):
//   cumulative index         -> pulse.total (cumulative pulse count)
//   most recent step sample  -> pulse.count (pulses in the reporting interval)
// No absolute timestamps in the datalog, so RFC3339 history cannot be built;
// the full increment array and the step (minutes) are exposed as extras.

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function stepFor(header) {
  if (header === 0x2b) { return 10; }
  if (header === 0x2c) { return 15; }
  if (header === 0x2d) { return 60; }
  return 0;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  var header = bytes[0];
  var i;

  // T1 fixed-step datalog (0x2b/0x2c/0x2d, 20 bytes): 24-bit index + 8 samples.
  if (header === 0x2b || header === 0x2c || header === 0x2d) {
    if (bytes.length !== 20) {
      return { errors: ['invalid T1 datalog length ' + bytes.length + ' (expected 20)'] };
    }
    var total = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    var samples = [];
    for (i = 0; i < 8; i++) {
      samples.push(u16be(bytes[4 + 2 * i], bytes[5 + 2 * i]));
    }
    return {
      data: {
        pulse: { total: total, count: samples[samples.length - 1] },
        increments: samples,
        stepMinutes: stepFor(header)
      }
    };
  }

  // T1 adjustable step (0x6b, 8..46 bytes): step, 32-bit index, N samples.
  if (header === 0x6b) {
    if (bytes.length < 8 || bytes.length > 46 || (bytes.length - 6) % 2 !== 0) {
      return { errors: ['invalid T1 adjustable-step length ' + bytes.length] };
    }
    var step = bytes[1];
    var atotal = (bytes[2] * 0x1000000) + (bytes[3] << 16) + (bytes[4] << 8) + bytes[5];
    var nb = (bytes.length - 6) / 2;
    var asamples = [];
    for (i = 0; i < nb; i++) {
      asamples.push(u16be(bytes[6 + 2 * i], bytes[7 + 2 * i]));
    }
    return {
      data: {
        pulse: { total: atotal, count: asamples[asamples.length - 1] },
        increments: asamples,
        stepMinutes: step
      }
    };
  }

  // T2 statistics frame (0x29, 10 bytes): 32-bit cumulative index + step.
  if (header === 0x29) {
    if (bytes.length !== 10) {
      return { errors: ['invalid T2 length ' + bytes.length + ' (expected 10)'] };
    }
    var t2total = (bytes[4] * 0x1000000) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];
    return { data: { pulse: { total: t2total }, stepMinutes: bytes[9] } };
  }

  if (header === 0x01) {
    return { errors: ['unsupported frame type 0x01 (START notification, not telemetry)'] };
  }
  return { errors: ['unknown frame header 0x' + header.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "fludia", model: "fm432p-10-15mn" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "fludia";
    result.data.model = "fm432p-10-15mn";
  }
  return result;
}
