// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Nwave NCC405SM (Smart Car Counter G4): a
// magnetometer / radar vehicle counter mounted at a car-park entry that reports
// a running cumulative vehicle count. Although marketed for vehicles, its
// decodable count fits the people-counter category's flow-count vocabulary.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/nwave/ncc405.js, attributed in
// NOTICE). Upstream emits a flat bag keyed by frame type; this module re-authors
// the JSON to the normalized vocabulary and never copies the upstream output.
//
// FPort selects the frame layout:
//   FPort 1  counter update    -> people.total (cumulative count)
//   FPort 2  heartbeat         -> battery (V) + hardware/battery diagnostics
//   FPort 3  startup           -> not a measurement (device restart) -> error
//   other                      -> error
//
// Field mapping:
//   FPort 1: counter_value ((bytes[0]<<8)+bytes[1]) -> people.total
//   FPort 2: battery voltage  = (2500 + bytes[1]*4) mV -> battery (mV -> V)
//            24h mean voltage = (2500 + bytes[2]*4) mV -> batteryMean24h (V extra)
//            hw_health_status = bytes[0] & 0x7F        -> hwHealthStatus (extra)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (input.fPort === 1) {
    if (bytes.length < 2) {
      return { errors: ['counter frame too short (expected 2 bytes)'] };
    }
    var data = {};
    data.people = { total: (bytes[0] << 8) + bytes[1] };
    return { data: data };
  }

  if (input.fPort === 2) {
    if (bytes.length < 3) {
      return { errors: ['heartbeat frame too short (expected 3 bytes)'] };
    }
    var hb = {};
    hb.battery = round((2500 + bytes[1] * 4) / 1000, 3);
    hb.batteryMean24h = round((2500 + bytes[2] * 4) / 1000, 3);
    hb.hwHealthStatus = bytes[0] & 0x7f;
    return { data: hb };
  }

  if (input.fPort === 3) {
    // Startup / restart frame — firmware version and reset cause, not a measurement.
    return { errors: ['startup frame carries no normalized measurement'] };
  }

  return { errors: ['unsupported fPort ' + input.fPort + ' (expected 1 or 2)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "nwave";
    result.data.model = "ncc405sm";
  }
  return result;
}
