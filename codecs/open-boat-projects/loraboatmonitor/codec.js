// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Open Boat Projects LoRa Boat Monitor: a
// multi-sensor boat node reporting BME280 air temperature / pressure / humidity
// / dewpoint, the boat's battery bus voltage and battery temperature, a GNSS
// position fix, two analog tank/bilge levels, a bilge alarm flag, and a relay
// state.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (fixed 27-byte little-endian frame) was ported faithfully from the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/open-boat-projects/loraboatmonitor.js, attributed in NOTICE). The
// upstream field extraction (per-field little-endian u16 slicing) is reproduced
// verbatim; only the JSON shape is re-authored to the normalized vocabulary
// (never the upstream output object).
//
// Faithfulness notes on the upstream decoder:
//   - Upstream emits a hardcoded device id (123456789), a hardcoded altitude
//     (1) and hdop (1.1), and a redundant `position: {value, context}` object
//     that merely duplicates the decoded lat/lng. None of those are decoded
//     from the payload bytes, so they are not propagated here.
//   - The upstream doc comment's example output is stale (it prints 20.1 C and
//     12.38 V); running the upstream code on its own sample payload yields
//     30.2 C and 1.238 V. This codec matches the running upstream code, which
//     is the source of truth.
//
// Byte layout (little-endian u16 unless noted), indices into input.bytes:
//   [0..1]   counter                                  -> counter (extra)
//   [2..3]   (u16/100) - 50  C    BME280 temperature  -> air.temperature
//   [4..5]   u16/10          hPa  pressure            -> air.pressure
//   [6..7]   u16/100         %    humidity            -> air.relativeHumidity
//   [8..9]   (u16/100) - 50  C    dewpoint            -> dewpoint (extra)
//   [10..11] u16/1000        V    battery bus voltage -> battery
//   [12..13] (u16/100) - 50  C    battery temperature -> batteryTemperature (extra)
//   [14..15] u16/100 deg + [16..17] u16/1e6  longitude -> position.longitude
//   [18..19] u16/100 deg + [20..21] u16/1e6  latitude  -> position.latitude
//   [22..23] u16/100             analog level 1        -> channels[] `level0`
//   [24..25] u16/100             analog level 2        -> channels[] `level1`
//   [26] bit0  bilge / water alarm (0|1)               -> water.leak (boolean)
//   [26] bit4  relay state         (0|1)               -> relay (extra)
//
// Battery voltage is reported in volts and maps to the vocabulary's `battery`
// (volts). Battery temperature and dewpoint have no vocabulary key and are
// emitted as camelCase extras.
//
// Multi-channel shape (`channels[]`) — the two analog levels are the only
// multi-position readings on this node: one physical quantity (an analog tank /
// bilge level) sampled at two sub-sensor positions. They move into the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") instead of the
// suffixed `level1` / `level2` extras this codec used to emit, one entry per
// analog input with identical scaling (u16 little-endian / 100, 2 decimals).
//
// Label scheme and renumbering — the labels are the project's own term for the
// reading plus a zero-based index, so they are renumbered against the upstream
// one-based field names:
//   `level0` = upstream level1 = bytes[22..23] (the old `level1` extra)
//   `level1` = upstream level2 = bytes[24..25] (the old `level2` extra)
// The label `level1` therefore means the SECOND input here and the FIRST input
// upstream — read the byte offsets, not the digit, when comparing to upstream.
//
// Per-entry key — the level rides in each entry as the unsuffixed camelCase
// extra `level`, NOT a vocabulary key. The reading is a bare analog sample with
// no engineering unit anywhere in the wire format or the upstream decoder: the
// project scales a raw u16 by /100 and calls it `level1`/`level2` with no scale,
// no empty/full geometry and no probe type, so it is neither `tank.level` (a
// percentage of a known geometry), nor `tank.distance` / `water.level` (metres),
// nor honestly `analog.voltage` / `analog.ratio` (we do not know that the /100
// yields volts or percent). Forcing any of those would invent a unit and a
// bound the device never states, so the honest shape is a per-entry extra whose
// scaling matches the old top-level extras exactly.
//
// What stays TOP-LEVEL (whole-device readings; never duplicated in entries):
// the BME280 air block (`air.temperature`, `air.pressure`,
// `air.relativeHumidity`) and `dewpoint`, the GNSS fix (`position.latitude` /
// `position.longitude`), `battery`, `batteryTemperature`, `counter`, and both
// bits of byte 26 — `water.leak` and `relay`. `water.leak` is the bilge alarm,
// a SINGLE sensor and not one of the two levels: upstream reads it as one flag
// from one bit (`data.alarm1 = input.bytes[26] & 0x01`), the frame has no
// per-level alarm bit, and it is a boolean state rather than an analog level, so
// it is a whole-device reading and not a channel entry. `relay` is actuator
// state the node was commanded into, not a measured position, and AUTHORING
// explicitly allows naming an extra for something that is not a measured
// position — so it stays a top-level extra too.
//
// Sentinel policy: the frame defines NO disconnected-input sentinel for either
// level. reference/upstream-codec.js scales both inputs unconditionally
// (`data.level1 = ((bytes[23] << 8) | bytes[22]) / 100`) and reserves no
// "channel not fitted" value — 0 is a legitimate empty-tank reading, which the
// upstream sample payload itself produces for both levels — so no value is
// treated as a sentinel and neither entry is ever suppressed on its reading.
// Nor can a short frame fabricate a level from `undefined`: the length guard
// below requires all 27 bytes, so bytes[22..25] are always present when a frame
// decodes. `channels` is built lazily and only attached when it has entries, so
// a future variant frame that carried no level bytes would omit the key rather
// than ship an empty array.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 27) {
    return { errors: ['payload too short for a LoRa Boat Monitor frame (expected 27 bytes)'] };
  }

  var data = {};
  var air = {};
  var water = {};

  // Counter (frame counter) — extra.
  data.counter = u16le(bytes[0], bytes[1]);

  // BME280 air temperature, pressure, humidity, dewpoint.
  air.temperature = round(u16le(bytes[2], bytes[3]) / 100 - 50, 1);
  air.pressure = round(u16le(bytes[4], bytes[5]) / 10, 1);
  air.relativeHumidity = round(u16le(bytes[6], bytes[7]) / 100, 2);
  data.dewpoint = round(u16le(bytes[8], bytes[9]) / 100 - 50, 1);
  data.air = air;

  // Battery bus voltage (volts) and battery temperature (C, extra).
  data.battery = round(u16le(bytes[10], bytes[11]) / 1000, 3);
  data.batteryTemperature = round(u16le(bytes[12], bytes[13]) / 100 - 50, 1);

  // GNSS position: degrees in the first u16 (/100) plus fractional minutes/
  // decimal in the second u16 (/1e6), per the upstream slicing.
  var longitude = u16le(bytes[14], bytes[15]) / 100 + u16le(bytes[16], bytes[17]) / 1000000;
  var latitude = u16le(bytes[18], bytes[19]) / 100 + u16le(bytes[20], bytes[21]) / 1000000;
  var position = {};
  if (latitude >= -90 && latitude <= 90) {
    position.latitude = round(latitude, 6);
  }
  if (longitude >= -180 && longitude <= 180) {
    position.longitude = round(longitude, 6);
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }

  // Analog tank / bilge levels — one channels[] entry per input, carrying the
  // unsuffixed `level` extra (no vocabulary key; see header). Labels are
  // zero-based: `level0` = bytes[22..23] (upstream level1), `level1` =
  // bytes[24..25] (upstream level2).
  var channels = [
    { channel: 'level0', level: round(u16le(bytes[22], bytes[23]) / 100, 2) },
    { channel: 'level1', level: round(u16le(bytes[24], bytes[25]) / 100, 2) }
  ];
  if (channels.length > 0) {
    data.channels = channels;
  }

  // Bilge / water alarm flag (bit 0) -> water.leak; relay state (bit 4) -> extra.
  water.leak = (bytes[26] & 0x01) === 0x01;
  data.water = water;
  data.relay = (bytes[26] & 0x10) === 0x10 ? 1 : 0;

  var warnings = [];
  if (data.battery < 10) {
    warnings.push('Battery undervoltage');
  }
  if (data.battery > 14.7) {
    warnings.push('Battery overload');
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "open-boat-projects";
    result.data.model = "loraboatmonitor";
  }
  return result;
}
