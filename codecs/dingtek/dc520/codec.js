// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DC520 (Bidirectional People Counter):
// a pedestrian flow counter that reports separate in / out counts plus a running
// net "balance" per uplink, together with battery voltage and alarm flags.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/dc520.js, attributed in
// NOTICE). Upstream emits a flat bag (balanceCounter, inCounter, outCounter,
// alarm*, volt, errorCode, frameCounter); this module re-authors the JSON to the
// normalized vocabulary and never copies the upstream output.
//
// All frames arrive on FPort 3. The payload length selects the layout:
//   19 bytes  data / event-trigger telemetry frame (a measurement)
//   18 bytes  parameter/config confirmation frame (device settings, not a
//             measurement) -> reported as an error
//
// Field mapping (19-byte data frame):
//   inCounter      ((bytes[7]<<8)+bytes[8])   -> people.in  (entries this interval)
//   outCounter     ((bytes[9]<<8)+bytes[10])  -> people.out (exits this interval)
//   balanceCounter ((bytes[5]<<8)+bytes[6])   -> people.total (running net count)
//   alarmBalance   (bytes[11] >> 4)           -> balanceAlarm (boolean extra)
//   alarmIn        (bytes[11] & 0x0F)         -> inAlarm (boolean extra)
//   alarmOut       (bytes[12] >> 4)           -> outAlarm (boolean extra)
//   alarmBattery   (bytes[12] & 0x0F)         -> batteryAlarm (boolean extra)
//   volt           ((bytes[13]<<8)+bytes[14]) -> battery (centivolts -> V, see note)
//   errorCode      (bytes[15])                -> errorCode (extra)
//   frameCounter   ((bytes[16]<<8)+bytes[17]) -> frameCounter (extra)
//
// Battery note: the DC500/DC510 siblings report battery as centivolts and divide
// by 100; the upstream DC520 decoder omits that divisor (returning raw counts).
// The Dingtek family encodes battery in centivolts, so we normalize
// battery = raw / 100 V to match the datasheet convention and the sibling codecs.

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

  if (bytes.length === 19) {
    var data = {};
    data.people = {
      in: (bytes[7] << 8) + bytes[8],
      out: (bytes[9] << 8) + bytes[10],
      total: (bytes[5] << 8) + bytes[6]
    };
    data.balanceAlarm = Boolean(bytes[11] >> 4);
    data.inAlarm = Boolean(bytes[11] & 0x0f);
    data.outAlarm = Boolean(bytes[12] >> 4);
    data.batteryAlarm = Boolean(bytes[12] & 0x0f);
    data.battery = round(((bytes[13] << 8) + bytes[14]) / 100, 2);
    data.errorCode = bytes[15];
    data.frameCounter = (bytes[16] << 8) + bytes[17];
    return { data: data };
  }

  if (bytes.length === 18) {
    // Parameter/config confirmation frame — device settings, not a measurement.
    return { errors: ['parameter confirmation frame carries no normalized measurement'] };
  }

  return { errors: ['wrong length (expected 19-byte telemetry frame)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dingtek", model: "dc520" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "dc520";
  }
  return result;
}
