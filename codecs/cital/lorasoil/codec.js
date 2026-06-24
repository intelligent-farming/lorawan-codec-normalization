// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Cital / Valenco LoRa Soil (lorasoil) — an
// in-ground soil probe with an on-board ambient micro-climate sensor and GNSS.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/cital/lorasoil.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// Wire layout (fPort 152), ported faithfully from the upstream decoder:
//   bytes[0..1]   off-board soil temperature, signed int16, 0.01 C
//   bytes[2..3]   off-board soil WATER POTENTIAL, uint16 / -100 (kPa, negative)
//   bytes[4]      battery charge, 0-100 (PERCENT, not volts)
//   bytes[5..6]   packed date  YYMM-ish (see timestamp math below)
//   bytes[7..8]   packed DDHH
//   bytes[9..10]  packed mmss
//   bytes[11..14] latitude,  signed int32 / 100000  (decimal degrees)
//   bytes[15..18] longitude, signed int32 / 100000  (decimal degrees)
//   bytes[19],[20] firmware major / minor
//   bytes[21..22] on-board ambient temperature, signed int16, 0.01 C   (>=26 B)
//   bytes[23..24] on-board ambient pressure, uint16 (hPa)              (>=26 B)
//   bytes[25]     on-board ambient humidity, 0-100 (%)                 (>=26 B)
//   bytes[26..29] off-board soil resistance, int32 (ohm)               (>=30 B)
//
// Normalization notes (divergences from upstream's flat output are deliberate):
//  - Upstream calls bytes[2..3] "soil_moisture", but it is the field
//    `waterPotOffBoard = raw / -100`: soil WATER POTENTIAL (a negative
//    pressure), NOT volumetric water content. It is routinely negative, so it
//    canNOT be the vocabulary `soil.moisture` (a 0-100 % percentage). It is
//    emitted as the camelCase extra `soilWaterPotential` (kPa). This device
//    therefore does not satisfy the soil-monitor category (no soil.moisture).
//  - Off-board soil temperature -> soil.temperature (vocab).
//  - On-board ambient channels -> air.temperature / air.relativeHumidity /
//    air.pressure (vocab). Upstream zero-fills these when the payload is short;
//    we only emit them when the bytes are actually present, because air.pressure
//    has a 900-1100 hPa bound that a zero-fill would violate.
//  - GNSS fix -> position.latitude / position.longitude (vocab).
//  - batteryCharge is 0-100 -> `batteryPercent` extra (the vocabulary `battery`
//    is volts; see AUTHORING.md "Battery is volts, not percent").
//  - The packed device clock -> `time` (RFC3339), computed with the upstream's
//    exact field math.
//  - soil_resistance and firmware are device diagnostics with no vocabulary key
//    -> camelCase extras `soilResistance` / `firmware`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Sign-extend a 16-bit two's-complement value (matches upstream Int16Array).
function s16(hi, lo) {
  return (((hi << 8) | lo) << 16) >> 16;
}

// Build a signed 32-bit two's-complement value from four bytes.
function s32(b0, b1, b2, b3) {
  return (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 152) {
    return { errors: ['unknown FPort ' + input.fPort + ' (expected 152)'] };
  }
  if (!bytes || bytes.length < 21) {
    return {
      errors: ['expected at least 21 bytes, got ' + (bytes ? bytes.length : 0)],
    };
  }

  var data = {};
  var soil = {};
  var position = {};

  // bytes[0..1]: off-board soil temperature, signed int16, 0.01 C resolution.
  soil.temperature = round(s16(bytes[0], bytes[1]) / 100, 2);

  data.soil = soil;

  // bytes[2..3]: off-board soil WATER POTENTIAL, uint16 / -100. Negative
  // pressure; not a moisture percentage, so a camelCase extra (not soil.*).
  data.soilWaterPotential = round(((bytes[2] << 8) | bytes[3]) / -100, 2);

  // bytes[4]: battery charge 0-100, a PERCENT -> batteryPercent extra.
  data.batteryPercent = bytes[4];

  // bytes[5..10]: packed device clock. Replicate the upstream field math
  // exactly, then express the result as an RFC3339 `time`.
  var raw56 = (bytes[5] << 8) | bytes[6];
  var year = Math.floor(raw56 / 100) + 2000;
  var month = parseInt(raw56.toString().substring(2, 4), 10) - 1;
  if (raw56 < 12) {
    month = 1;
  }
  var raw78 = (bytes[7] << 8) | bytes[8];
  var day = Math.floor(raw78 / 100);
  var hour = raw78 - day * 100;
  var raw910 = (bytes[9] << 8) | bytes[10];
  var minute = Math.floor(raw910 / 100);
  var second = raw910 - minute * 100;
  var ts = Date.UTC(year, month, day, hour, minute, second);
  if (!isNaN(ts)) {
    data.time = new Date(ts).toISOString();
  }

  // bytes[11..14] / [15..18]: GNSS fix, signed int32 / 100000 decimal degrees.
  position.latitude = round(s32(bytes[11], bytes[12], bytes[13], bytes[14]) / 100000, 5);
  position.longitude = round(s32(bytes[15], bytes[16], bytes[17], bytes[18]) / 100000, 5);
  data.position = position;

  // bytes[19],[20]: firmware major.minor -> diagnostic extra.
  data.firmware = parseFloat(bytes[19] + '.' + bytes[20]);

  // bytes[21..25]: on-board ambient micro-climate sensor (when present).
  if (bytes.length >= 26) {
    var air = {};
    air.temperature = round(s16(bytes[21], bytes[22]) / 100, 2);
    air.pressure = (bytes[23] << 8) | bytes[24];
    air.relativeHumidity = bytes[25];
    data.air = air;
  }

  // bytes[26..29]: off-board soil resistance (ohm) -> diagnostic extra.
  if (bytes.length >= 30) {
    data.soilResistance = s32(bytes[26], bytes[27], bytes[28], bytes[29]);
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "cital";
    result.data.model = "lorasoil";
  }
  return result;
}
