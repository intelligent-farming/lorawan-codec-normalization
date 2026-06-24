// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DC410 (LoRaWAN ultrasonic manhole /
// fill-level sensor: fill distance in mm, device temperature, a tilt/motion
// alarm flag, a "full" alarm flag, a low-battery threshold flag and a frame
// counter). Despite earlier evaluation for the gps-tracker category, this device
// carries NO GNSS fix on any frame — it only reports a motion (tilt) alarm
// boolean, so it is normalized to the `motion` category.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/dc410.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets; status nibbles) is
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream output object).
//
// All uplinks arrive on FPort 3. The payload length selects the layout:
//   17 bytes                      Heartbeat / data frame (a measurement).
//   25 bytes, bytes[3] == 0x03    Parameter-report / command-confirmation frame
//                                 (upload/detection intervals, alarm thresholds,
//                                 motion-alarm enable, ultrasonic range) — device
//                                 settings, not a measurement, reported as an
//                                 error.
//
// Field mapping:
//   motion/tilt alarm (bytes[12] high nibble) -> action.motion.detected
//   temperature (°C, bytes[8])                -> air.temperature
//   level (mm, big-endian)                    -> levelMm (extra; distance reading)
//   tilt angle (°, signed)                    -> tiltAngle (extra)
//   full alarm flag                           -> full (boolean extra)
//   low-battery flag                          -> batteryLow (boolean extra; NOT
//                                                vocabulary `battery`, which is
//                                                volts — the device only reports a
//                                                threshold flag, not a voltage)
//   frame counter (16-bit big-endian)         -> frameCounter (extra)
//
// Upstream sign bug (corrected here): upstream computes the tilt angle as
// `bytes[9] & (0x0f === 0x00) ? bytes[10] : 0 - bytes[10]`. `(0x0f === 0x00)` is a
// constant `false`, so `bytes[9] & false` is always 0 (falsy) and upstream always
// negates the magnitude. The clear intent is a sign nibble: a zero low nibble on
// the sign byte means a positive angle, otherwise negative. We implement that.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Signed tilt angle: sign byte low nibble 0 -> positive, otherwise negative.
function tiltAngle(signByte, magByte) {
  if ((signByte & 0x0f) !== 0) {
    return -magByte;
  }
  return magByte;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (bytes.length === 17) {
    var data = {
      action: { motion: { detected: Boolean(bytes[12] >> 4) } },
      air: { temperature: round(bytes[8], 0) },
      levelMm: (bytes[5] << 8) + bytes[6],
      tiltAngle: tiltAngle(bytes[9], bytes[10]),
      full: Boolean(bytes[11] >> 4),
      batteryLow: Boolean(bytes[12] & 0x0f),
      frameCounter: (bytes[13] << 8) + bytes[14]
    };
    return { data: data };
  }

  if (bytes.length === 25) {
    if (bytes[3] === 0x03) {
      // Parameter-report / command-confirmation frame — device settings, not a
      // normalized measurement.
      return { errors: ['parameter report frame carries no normalized measurement'] };
    }
    return { errors: ['unsupported 25-byte frame (expected parameter report with bytes[3] == 0x03)'] };
  }

  return { errors: ['wrong length (expected 17 or 25 bytes)'] };
}
