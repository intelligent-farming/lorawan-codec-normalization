// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF200 (Soap Dispenser Level Sensor):
// a liquid-level sensor that reports the fill level of a soap dispenser
// reservoir as a percentage, plus internal temperature, battery voltage, and
// low-level / low-battery alarm flags.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df200.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets) is reproduced
// faithfully; only the JSON shape is re-authored to the normalized vocabulary
// (never the upstream output).
//
// All frames arrive on FPort 3. The payload length selects the layout:
//   15 bytes  data / heartbeat frame (a measurement)
//   13 bytes  parameter/config confirmation frame (device settings, not a
//             measurement) -> reported as an error
//
// Field mapping (15-byte data frame):
//   level (bytes[9], %)               -> tank.level (fill percentage, 0-100)
//   temperature (bytes[8], °C)        -> temperature (standalone probe reading)
//   volt ((bytes[5]<<8|bytes[6])/100) -> battery (already volts upstream)
//   alarmLevel (bytes[10] & 0x0f)     -> alarmLevel (boolean extra)
//   alarmBattery (bytes[7] & 0x0f)    -> alarmBattery (boolean extra)
//   frameCounter                      -> frameCounter (extra)
//
// tank.level semantics: the device natively reports a fill percentage. The
// upstream `levelThreshold` downlink is documented as "level alarm threshold
// range 25/50/75/100" and the TTN example reports level=75, confirming the
// value is a fill percentage (0-100), not a distance.

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

  if (bytes.length === 15) {
    var data = {};
    data.tank = { level: bytes[9] };
    data.temperature = bytes[8];
    data.battery = round(((bytes[5] << 8) + bytes[6]) / 100, 2);
    data.alarmLevel = Boolean(bytes[10] & 0x0f);
    data.alarmBattery = Boolean(bytes[7] & 0x0f);
    data.frameCounter = (bytes[11] << 8) + bytes[12];
    return { data: data };
  }

  if (bytes.length === 13) {
    // Parameter/config confirmation frame — device settings, not a measurement.
    return { errors: ['parameter confirmation frame carries no normalized measurement'] };
  }

  return { errors: ['wrong length (expected 15-byte telemetry frame)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dingtek", model: "df200" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "df200";
  }
  return result;
}
