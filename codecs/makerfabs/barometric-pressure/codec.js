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
//
// SIGN EXTENSION (a fixed upstream bug): upstream reads the temperature word as
// unsigned, so a sub-zero reading decodes as ~4.29e7 °C rather than a negative
// number. That value clears the vocabulary's `air.temperature` bound (minimum
// -273.15) and so would be stored as a plausible-looking reading rather than
// rejected — on a device deployed outdoors, where sub-zero is routine. This
// codec applies two's complement over the full 32-bit field, matching how every
// sibling in this family (ath20, air-temperature-and-humidity,
// temperature-humidity-sht31, soil-monitor, leaf-moisture-sn-3001,
// rtd-pt1000-temperature) sign-extends its own temperature word. The negative
// vector below is synthetic: the vendor supplies no sub-zero example, so a real
// cold-weather capture should confirm the encoding (a device that sign-extends
// only the low 16 bits into the upper bytes decodes identically here).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Two's-complement interpretation of a 32-bit big-endian field. Built by
// multiplication rather than shifts: `<<` coerces to int32, which would silently
// wrap the pressure field's larger magnitudes.
function signed32(b0, b1, b2, b3) {
  var v = b0 * 16777216 + b1 * 65536 + b2 * 256 + b3;
  if (v >= 2147483648) {
    v -= 4294967296;
  }
  return v;
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
  var temp = signed32(bytes[7], bytes[8], bytes[9], bytes[10]) / 100.0;

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
