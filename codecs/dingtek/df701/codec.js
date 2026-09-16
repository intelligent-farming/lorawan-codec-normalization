// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF701 (Indoor Waste Bin Laser Level
// Sensor): a top-mounted laser ranging sensor that measures the distance from
// the lid down to the top of the refuse in an indoor waste bin, reporting a
// "full" alarm when that distance drops below a configured threshold. Each data
// frame carries the ranging distance, battery voltage, and full / low-battery
// alarm flags.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df701.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets) is reproduced
// faithfully; only the JSON shape is re-authored to the normalized vocabulary
// (never the upstream output).
//
// All frames arrive on FPort 3. The payload length selects the layout:
//   18 bytes  data / heartbeat frame (a measurement)
//   12 bytes  parameter/config confirmation frame (device settings, not a
//             measurement) -> reported as an error
//
// Field mapping (18-byte data frame):
//   level ((bytes[5]<<8)+bytes[6], cm) -> tank.distance (m; ÷100 cm->m)
//   alarmLevel (bytes[11] >> 4)        -> alarmLevel (boolean extra; "bin full")
//   alarmBattery (bytes[12] & 0x0f)    -> alarmBattery (boolean extra)
//   volt ((bytes[13]<<8|bytes[14])/100 -> battery (already volts upstream)
//   frameCounter                       -> frameCounter (extra)
//
// tank.distance semantics: this is a laser RANGE sensor, not a fill-percentage
// sensor. The upstream `levelThreshold` downlink is documented as "full alarm
// threshold range 15-255 cm", establishing that the reported `level` is a
// distance in centimetres measured from the sensor down to the refuse surface
// (it decreases as the bin fills — exactly the tank.distance convention). We
// therefore map it to tank.distance in metres (cm ÷ 100) rather than tank.level.
//
// Sentinel handling: the TTN example reports level=9999, which is far outside
// the 15-255 cm operating range — the device's "no valid target / out of range"
// sentinel. We surface it as the boolean extra `noTarget` and still emit the raw
// converted distance (99.99 m) rather than fabricate or drop the reading, so the
// consumer can detect the invalid measurement.

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

  if (bytes.length === 18) {
    var levelCm = (bytes[5] << 8) + bytes[6];
    var data = {};
    data.tank = { distance: round(levelCm / 100, 2) };
    if (levelCm >= 9999) {
      // Out-of-range sentinel: no valid laser target within operating range.
      data.noTarget = true;
    }
    data.alarmLevel = Boolean(bytes[11] >> 4);
    data.alarmBattery = Boolean(bytes[12] & 0x0f);
    data.battery = round(((bytes[13] << 8) + bytes[14]) / 100, 2);
    data.frameCounter = (bytes[15] << 8) + bytes[16];
    return { data: data };
  }

  if (bytes.length === 12) {
    // Parameter/config confirmation frame — device settings, not a measurement.
    return { errors: ['parameter confirmation frame carries no normalized measurement'] };
  }

  return { errors: ['wrong length (expected 18-byte telemetry frame)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dingtek", model: "df701" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "df701";
  }
  return result;
}
