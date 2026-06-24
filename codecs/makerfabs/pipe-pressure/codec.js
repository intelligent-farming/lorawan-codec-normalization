// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs AgroSense Pipe Pressure sensor
// (line/pipe pressure + battery + reporting interval).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/pipe-pressure.js,
// attributed in NOTICE) — the upstream decodeUplink byte layout is the source
// of truth for the wire format and unit scaling. We author the normalization
// here; the upstream `field1..field4` output shape is not reused.
//
// Wire format (carried verbatim from upstream):
//   bytes[0..1]    sample counter, big-endian               -> sampleCount (extra)
//   byte[2]        battery, tenths of a volt                 -> battery V   (/10)
//   bytes[3..4]    sensor voltage, big-endian, raw/1000      -> V (intermediate)
//   bytes[13..16]  reporting interval, big-endian, raw/1000  -> s (extra)
//
// The pipe pressure is a CALIBRATED engineering-unit reading: upstream applies
// the sensor transfer function (Volt - 0.483) * 250, yielding kilopascals
// directly. This is a line pressure measured RELATIVE to ambient (vented gauge
// transmitter), so it maps to the vocabulary `pressure.gauge` (kPa) with no
// further conversion. Battery is a VOLTAGE (tenths of a volt) -> `battery` (V).
// The sample counter and reporting interval are device diagnostics with no
// vocabulary home, emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 17) {
    return { errors: ['payload too short: expected at least 17 bytes'] };
  }

  var sampleCount = bytes[0] * 256 + bytes[1];
  var bat = bytes[2] / 10.0;
  var voltPressure = (bytes[3] * 256 + bytes[4]) / 1000.0;
  var pipePressure = (voltPressure - 0.483) * 250; // kPa
  var interval =
    (bytes[13] * 16777216 +
      bytes[14] * 65536 +
      bytes[15] * 256 +
      bytes[16]) /
    1000.0; // seconds

  return {
    data: {
      battery: round(bat, 1),
      pressure: {
        gauge: round(pipePressure, 3)
      },
      sampleCount: sampleCount,
      reportingInterval: round(interval, 3)
    }
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "pipe-pressure";
  }
  return result;
}
