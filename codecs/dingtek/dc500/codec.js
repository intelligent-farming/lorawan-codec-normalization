// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DC500 (People Counter): a pedestrian
// counter that reports a single cumulative people count per uplink together
// with battery voltage and alarm flags.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/dc500.js, attributed in
// NOTICE). Upstream emits a flat bag (peopleCounter, alarmCounter, alarmBattery,
// volt, frameCounter); this module re-authors the JSON to the normalized
// vocabulary and never copies the upstream output.
//
// All frames arrive on FPort 3. The payload length selects the layout:
//   21 bytes  data / event-trigger telemetry frame (a measurement)
//   12 bytes  parameter/config confirmation frame (device settings, not a
//             measurement) -> reported as an error
//
// Field mapping (21-byte data frame):
//   peopleCounter ((bytes[5]<<8)+bytes[6]) -> people.total (cumulative net count)
//   alarmCounter  (bytes[7] & 0xF0)        -> countAlarm (boolean extra)
//   alarmBattery  (bytes[7] & 0x0F)        -> batteryAlarm (boolean extra)
//   volt ((bytes[9]<<8|bytes[10]) / 100)   -> battery (centivolts -> V)
//   frameCounter  ((bytes[17]<<8)+bytes[18]) -> frameCounter (extra)
//
// people.total semantics: the DC500 reports one running counter (not separate
// in/out streams), so the cumulative reading maps to people.total.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (bytes.length === 21) {
    var data = {};
    data.people = { total: (bytes[5] << 8) + bytes[6] };
    data.countAlarm = Boolean(bytes[7] & 0xf0);
    data.batteryAlarm = Boolean(bytes[7] & 0x0f);
    data.battery = round(((bytes[9] << 8) + bytes[10]) / 100, 2);
    data.frameCounter = (bytes[17] << 8) + bytes[18];
    return { data: data };
  }

  if (bytes.length === 12) {
    // Parameter/config confirmation frame — device settings, not a measurement.
    return { errors: ['parameter confirmation frame carries no normalized measurement'] };
  }

  return { errors: ['wrong length (expected 21-byte telemetry frame)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "dc500";
  }
  return result;
}
