// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DC413 (LoRaWAN manhole sensor: liquid
// level, device temperature, tilt angle, and full / fall / low-battery status
// flags). The fall (tilt) alarm is a motion event — the sensor reports that the
// manhole cover/unit has been moved, tilted, or knocked over — so this device is
// normalized into the `motion` category.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/dc413.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets; status nibbles;
// big-endian level/frame-counter) is reproduced faithfully; only the JSON shape
// is re-authored to the normalized vocabulary (never the upstream output object).
//
// All uplinks arrive on FPort 3. The payload length selects the layout:
//   17 bytes                    Data frame (a measurement).
//   25 bytes, bytes[3] == 0x03  Parameter report (firmware / intervals /
//                               thresholds / work mode) — device settings, not a
//                               measurement, reported as an error.
//
// Status / field semantics (faithful to upstream):
//   bytes[5..6]   16-bit big-endian liquid level (cm).
//   bytes[8]      device temperature, whole degrees C.
//   bytes[9..10]  tilt angle: low nibble of the sign byte (bytes[9]) selects sign
//                 (0 -> positive, otherwise negative), bytes[10] is the magnitude.
//   bytes[11] high nibble  level (full) alarm flag.
//   bytes[12] high nibble  fall (tilt) alarm flag  -> MOTION event.
//   bytes[12] low nibble   low-battery alarm flag.
//   bytes[13..14] 16-bit big-endian frame counter.
//
// Upstream sign bug (corrected here): upstream computes the tilt sign as
// `bytes[9] & (0x0f === 0x00) ? bytes[10] : 0 - bytes[10]`. `(0x0f === 0x00)` is a
// constant `false`, so `bytes[9] & false` is always 0 (falsy) and upstream always
// negates the magnitude. The clear intent is a sign nibble; we implement that.
//
// Field mapping:
//   fall (tilt) alarm flag       -> action.motion.detected (true = unit moved)
//   temperature (°C)             -> air.temperature
//   liquid level (cm)            -> level (extra)
//   tilt angle (°, signed)       -> tiltAngle (extra)
//   level (full) alarm flag      -> alarmLevel (boolean extra)
//   low-battery flag             -> batteryLow (boolean extra; NOT vocabulary
//                                   `battery`, which is volts — the device only
//                                   reports a threshold flag, not a voltage)
//   frame counter                -> frameCounter (extra)

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

  if (bytes.length === 25) {
    if (bytes[3] === 0x03) {
      // Parameter report — device settings, not a normalized measurement.
      return { errors: ['parameter report frame carries no normalized measurement'] };
    }
    return { errors: ['wrong length (expected 17 bytes)'] };
  }

  if (bytes.length !== 17) {
    return { errors: ['wrong length (expected 17 bytes)'] };
  }

  var data = {
    action: {
      motion: {
        detected: Boolean(bytes[12] >> 4)
      }
    },
    air: {
      temperature: round(bytes[8], 0)
    },
    level: (bytes[5] << 8) + bytes[6],
    tiltAngle: tiltAngle(bytes[9], bytes[10]),
    alarmLevel: Boolean(bytes[11] >> 4),
    batteryLow: Boolean(bytes[12] & 0x0f),
    frameCounter: (bytes[13] << 8) + bytes[14]
  };

  return { data: data };
}
