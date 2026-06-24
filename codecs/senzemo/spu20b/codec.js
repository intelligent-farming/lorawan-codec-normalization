// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Senzemo SPU20B (Senspuck Pure Battery) — an
// indoor LoRaWAN air-quality node measuring CO2, TVOC, temperature, relative
// humidity, and barometric pressure.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Senzemo fixed-layout big-endian frame) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/senzemo/spu20.js, attributed in NOTICE).
//
// Notes on divergence from upstream:
//   - Upstream returns `undefined` for any frame whose length is neither 15
//     (data) nor 10 (config); we return an explicit { errors: [...] } instead.
//   - The vocabulary's `battery` is volts. The device reports a raw Voltage in
//     millivolts (ER14505 cell, ~3.6 V nominal), so we divide by 1000 into
//     `battery` rather than emitting the raw count.
//   - The config frame (length 10) carries only device metadata, not
//     measurements, so it yields no normalized data and is reported as an error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (bytes.length !== 15) {
    return { errors: ['unexpected payload length ' + bytes.length + '; expected 15-byte data frame'] };
  }

  var data = {};
  var air = {};

  air.temperature = round(s16be(bytes[1], bytes[2]) / 100, 2);
  air.relativeHumidity = round(u16be(bytes[3], bytes[4]) / 100, 2);
  air.pressure = round(u16be(bytes[5], bytes[6]) / 10, 1);
  air.co2 = u16be(bytes[9], bytes[10]);
  data.air = air;

  // TVOC has no vocabulary key; emit as a camelCase extra (mg/m3 per datasheet).
  data.tvoc = round(u16be(bytes[7], bytes[8]) / 100, 2);

  // Raw Voltage is millivolts; the vocabulary `battery` is volts.
  data.battery = round(u16be(bytes[11], bytes[12]) / 1000, 3);

  // Status byte: vendor diagnostic flags, not modeled by the vocabulary.
  data.status = bytes[0];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "senzemo";
    result.data.model = "spu20b";
  }
  return result;
}
