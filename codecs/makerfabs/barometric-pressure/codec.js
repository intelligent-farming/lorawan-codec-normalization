// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs Barometric Pressure sensor
// (atmospheric pressure + temperature + battery).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/barometric-pressure.js,
// attributed in NOTICE) — the upstream decodeUplink byte layout is the source
// of truth for the wire format and unit scaling. We author the normalization
// here; the upstream `field1/field2/field3` output shape is not reused.
//
// Wire format (carried verbatim from upstream):
//   byte[2]        battery, tenths of a volt        -> V         (/10)
//   bytes[3..6]    pressure, big-endian, raw/100000 -> hPa       (/100000)
//   bytes[7..10]   temperature, big-endian, raw/100 -> degC      (/100)
//
// The pressure channel is a genuine ATMOSPHERIC barometer reading: upstream
// `raw / 100000` yields hectopascals directly (raw 101325000 -> 1013.25 hPa),
// so it maps to the vocabulary `air.pressure` (hPa) with no further conversion.
// Battery is a VOLTAGE (tenths of a volt), so it maps to `battery` (volts).
// Upstream applies no sign extension to the temperature word; kept verbatim.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 11) {
    return { errors: ['payload too short: expected at least 11 bytes'] };
  }

  var bat = bytes[2] / 10.0;
  var press =
    (bytes[3] * 16777216 + bytes[4] * 65536 + bytes[5] * 256 + bytes[6]) /
    100000.0;
  var temp =
    (bytes[7] * 16777216 + bytes[8] * 65536 + bytes[9] * 256 + bytes[10]) /
    100.0;

  return {
    data: {
      battery: round(bat, 1),
      air: {
        temperature: round(temp, 2),
        pressure: round(press, 2)
      }
    }
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "barometric-pressure";
  }
  return result;
}
