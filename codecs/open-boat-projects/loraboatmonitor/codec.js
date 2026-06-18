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
//   [22..23] u16/100             analog level 1        -> level1 (extra)
//   [24..25] u16/100             analog level 2        -> level2 (extra)
//   [26] bit0  bilge / water alarm (0|1)               -> water.leak (boolean)
//   [26] bit4  relay state         (0|1)               -> relay (extra)
//
// Battery voltage is reported in volts and maps to the vocabulary's `battery`
// (volts). Battery temperature and dewpoint have no vocabulary key and are
// emitted as camelCase extras; the two analog tank/bilge levels are device
// values the vocabulary does not model and are emitted as `level1` / `level2`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
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

  // Analog tank / bilge levels — extras (no vocabulary key).
  data.level1 = round(u16le(bytes[22], bytes[23]) / 100, 2);
  data.level2 = round(u16le(bytes[24], bytes[25]) / 100, 2);

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
