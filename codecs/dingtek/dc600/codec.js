// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DC600 (LoRaWAN water-leakage sensor
// with four independent leak-detection channels — typically four rope/spot
// probes — plus device temperature, a low-battery flag and a monitoring-enabled
// status flag).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/dc600.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets; status nibbles)
// is reproduced faithfully; only the JSON shape is re-authored to the
// normalized vocabulary (never the upstream output object).
//
// All uplinks arrive on FPort 3. The 4th byte (bytes[3]) selects the layout:
//   17 bytes, bytes[3] != 0x03   Heartbeat / leak report (a measurement).
//   17 bytes, bytes[3] == 0x03   Parameter report (firmware / interval / battery
//                                threshold / monitor flag) — device settings,
//                                not a measurement, reported as an error.
//
// Status-byte semantics (faithful to upstream):
//   bytes[11] bit0  monitor-enabled flag. Upstream reads `!Boolean(b & 0x01)`,
//                   i.e. a SET bit means monitoring is OFF; a clear bit means ON.
//   bytes[12] bits 0x10/0x20/0x40/0x80  per-channel leak ALARM (channels 1-4).
//                   These are active-LOW: upstream reads `!Boolean(b & mask)`, so
//                   a CLEAR bit means that channel is alarming (leak detected).
//   bytes[12] low nibble (0x0f)  low-battery alarm flag (active-high).
//   bytes[8]  device temperature, whole degrees C.
//   bytes[13..14]  16-bit big-endian frame counter.
//
// Field mapping:
//   any channel alarm active      -> water.leak (boolean; true = leak detected)
//   per-channel alarm flags        -> leakChannel1..leakChannel4 (boolean extras)
//   temperature (°C)               -> water.temperature.current
//   monitor-enabled flag           -> monitorEnabled (boolean extra)
//   low-battery flag               -> batteryLow (boolean extra; NOT vocabulary
//                                    `battery`, which is volts — the device only
//                                    reports a threshold flag, not a voltage)
//   frame counter                  -> frameCounter (extra)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (bytes.length !== 17) {
    return { errors: ['wrong length (expected 17 bytes)'] };
  }
  if (bytes[3] === 0x03) {
    // Parameter report — device settings, not a normalized measurement.
    return { errors: ['parameter report frame carries no normalized measurement'] };
  }

  // Per-channel leak alarms are active-LOW (a clear status bit = leak).
  var leak1 = !Boolean(bytes[12] & 0x10);
  var leak2 = !Boolean(bytes[12] & 0x20);
  var leak3 = !Boolean(bytes[12] & 0x40);
  var leak4 = !Boolean(bytes[12] & 0x80);

  var data = {
    water: {
      leak: leak1 || leak2 || leak3 || leak4,
      temperature: { current: round(bytes[8], 0) }
    },
    leakChannel1: leak1,
    leakChannel2: leak2,
    leakChannel3: leak3,
    leakChannel4: leak4,
    monitorEnabled: !Boolean(bytes[11] & 0x01),
    batteryLow: Boolean(bytes[12] & 0x0f),
    frameCounter: (bytes[13] << 8) + bytes[14]
  };

  return { data: data };
}
