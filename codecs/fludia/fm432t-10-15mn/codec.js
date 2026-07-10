// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for fludia/fm432t-10-15mn.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/fludia/fm432t-10-15mn-decode.js,
// attributed in NOTICE). Normalization authored here; upstream normalizeUplink
// is NOT copied.
//
// Wire format (dispatched by leading header byte, not fPort):
//   T1 (0x57, 18 bytes): datalog frame. byte[1] = time step, followed by 8
//     big-endian signed-16 temperature samples (hundredths of a degree C).
//     temperature = signed16(hi, lo) / 100  ->  degrees Celsius.
//   T2 (0x58, 12 bytes): configuration/statistics frame (firmware, min/max,
//     sampling mode) -- not the primary telemetry.
//   START (0x01, 3 bytes): device start notification -- not telemetry.
// This variant differs from fm432t-1mn only in report interval (fewer samples
// per datalog frame). The datalog carries no absolute timestamps, so per-sample
// RFC3339 history cannot be reconstructed; the most recent sample (last element)
// is reported as the top-level temperature and the full sample array is exposed
// as an extra.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  var v = (hi << 8) | lo;
  if (v & 0x8000) {
    v -= 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var header = bytes[0];

  // Primary telemetry: T1 datalog frame (0x57, 18 bytes, 8 samples).
  if (header === 0x57) {
    if (bytes.length !== 18) {
      return { errors: ['invalid T1 datalog length ' + bytes.length + ' (expected 18)'] };
    }
    var samples = [];
    for (var i = 0; i < 8; i++) {
      samples.push(round(signed16(bytes[2 + 2 * i], bytes[3 + 2 * i]) / 100, 2));
    }
    var data = {};
    data.temperature = samples[samples.length - 1];
    data.temperatures = samples;
    data.timeStep = bytes[1];
    return { data: data };
  }

  if (header === 0x58) {
    return { errors: ['unsupported frame type 0x58 (T2 configuration/statistics, not telemetry)'] };
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
    result.data.model = "fm432t-10-15mn";
  }
  return result;
}
