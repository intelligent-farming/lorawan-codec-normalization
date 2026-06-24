// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs / AgroSense Soil Monitor
// (in-ground soil moisture, temperature, electrical conductivity & pH probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/soil-monitor.js, attributed
// in NOTICE); the normalization below is authored for this module, not copied.
//
// Wire layout (16-byte uplink), ported faithfully from the upstream decoder:
//   bytes[0..1]  reserved (upstream reads but does not emit it)
//   bytes[2]     battery, 0.1 V resolution            -> battery (V)
//   bytes[3]     "Significant" validity flag; 0 == data invalid
//   bytes[4..5]  soil moisture, 0.1 % resolution       -> soil.moisture (%)
//   bytes[6..7]  soil temperature, signed, 0.1 C       -> soil.temperature (C)
//   bytes[8..9]  soil electrical conductivity (uS/cm)  -> soil.ec (dS/m, /1000)
//   bytes[10..11] soil pH, 0.1 resolution              -> soil.pH
//   bytes[12..15] transmit interval, milliseconds      -> transmitInterval (s)
//
// Upstream emits the integrated probe's moisture/temperature channels as the
// generic field names "humi"/"temp"; on this soil probe they are the soil
// volumetric water content and soil temperature, so they normalize to the
// `soil.*` vocabulary. Conductivity is uS/cm on the wire and is divided by 1000
// to the vocabulary's dS/m (see definitions/categories/soil-monitor.json).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 16) {
    return { errors: ['expected at least 16 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  // bytes[3]: validity flag. Upstream returns {Significant: "data invalid"}
  // when this byte is falsy.
  if (!bytes[3]) {
    return { errors: ['data invalid (Significant flag clear)'] };
  }

  var data = {};
  var soil = {};

  // bytes[2]: battery, 0.1 V resolution.
  data.battery = round(bytes[2] / 10, 1);

  // bytes[4..5]: soil moisture, 0.1 % resolution.
  soil.moisture = round((bytes[4] * 256 + bytes[5]) / 10, 1);

  // bytes[6..7]: soil temperature, signed 16-bit, 0.1 C resolution.
  var tRaw = bytes[6] * 256 + bytes[7];
  if (tRaw >= 0x8000) {
    tRaw = tRaw - 0x10000;
  }
  soil.temperature = round(tRaw / 10, 1);

  // bytes[8..9]: soil electrical conductivity, uS/cm -> dS/m (/1000).
  soil.ec = round((bytes[8] * 256 + bytes[9]) / 1000, 3);

  // bytes[10..11]: soil pH, 0.1 resolution.
  soil.pH = round((bytes[10] * 256 + bytes[11]) / 10, 1);

  data.soil = soil;

  // bytes[12..15]: transmit interval, milliseconds -> seconds. Device-specific
  // diagnostic; not in the vocabulary, so emitted as a camelCase extra.
  var intervalMs =
    bytes[12] * 16777216 + bytes[13] * 65536 + bytes[14] * 256 + bytes[15];
  data.transmitInterval = round(intervalMs / 1000, 3);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "soil-monitor";
  }
  return result;
}
