// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF400 (Tissue Dispenser Level
// Sensor): a ranging sensor that detects the remaining paper in a tissue /
// toilet-paper dispenser. Each data frame carries BOTH a raw 16-bit ranging
// reading and a derived fill percentage, plus internal temperature, battery
// voltage, and low-level / low-battery alarm flags.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df400.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets) is reproduced
// faithfully; only the JSON shape is re-authored to the normalized vocabulary
// (never the upstream output).
//
// All frames arrive on FPort 3. The payload length selects the layout:
//   17 bytes  data / heartbeat frame (a measurement)
//   13 bytes  parameter/config confirmation frame (device settings, not a
//             measurement) -> reported as an error
//
// Field mapping (17-byte data frame):
//   percent (bytes[11], %)            -> tank.level (fill percentage, 0-100)
//   level ((bytes[9]<<8)+bytes[10])   -> rawLevel (extra; raw 16-bit ranging
//                                        reading, kept verbatim)
//   temperature (bytes[8], °C)        -> temperature (standalone probe reading)
//   volt ((bytes[5]<<8|bytes[6])/100) -> battery (already volts upstream)
//   alarmLevel (bytes[12] & 0x0f)     -> alarmLevel (boolean extra)
//   alarmBattery (bytes[7] & 0x0f)    -> alarmBattery (boolean extra)
//   frameCounter                      -> frameCounter (extra)
//
// tank.level semantics: unlike the DF200 (whose single `level` byte is itself
// the percentage), the DF400 emits a distinct `percent` byte that is the
// derived fill percentage (TTN example: percent=75), while the 16-bit `level`
// is the underlying raw ranging count (example: 70, units not documented in the
// upstream codec/datasheet). We map the documented fill percentage `percent` to
// tank.level and preserve the ambiguous raw ranging value as the extra
// `rawLevel` rather than fabricate a distance unit for it.

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

  if (bytes.length === 17) {
    var data = {};
    data.tank = { level: bytes[11] };
    data.rawLevel = (bytes[9] << 8) + bytes[10];
    data.temperature = bytes[8];
    data.battery = round(((bytes[5] << 8) + bytes[6]) / 100, 2);
    data.alarmLevel = Boolean(bytes[12] & 0x0f);
    data.alarmBattery = Boolean(bytes[7] & 0x0f);
    data.frameCounter = (bytes[13] << 8) + bytes[14];
    return { data: data };
  }

  if (bytes.length === 13) {
    // Parameter/config confirmation frame — device settings, not a measurement.
    return { errors: ['parameter confirmation frame carries no normalized measurement'] };
  }

  return { errors: ['wrong length (expected 17-byte telemetry frame)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "df400";
  }
  return result;
}
