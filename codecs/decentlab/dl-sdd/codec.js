// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-SDD (Soil Moisture, Temperature and
// Salinity Profile sensor for LoRaWAN) — a multi-level profile probe reporting
// soil moisture, soil temperature and a salinity index at up to 12 discrete
// levels plus battery.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-sdd.js, attributed in
// NOTICE). The per-channel conversion formulas below are ported faithfully from
// the upstream SENSORS table; the upstream decodeUplink emits one raw object per
// level (`moisture_at_level_N` / `temperature_at_level_N` /
// `salinity_at_level_N`). The results are then mapped onto the shared normalized
// vocabulary.
//
// Sensor block layout (flag-bit order, LSB first), from the upstream SENSORS
// table:
//   bit0 soil profile, levels 0-5  (18 words: 6 moisture, 6 temperature,
//                                    6 salinity, in that order)
//   bit1 soil profile, levels 6-11 (18 words, same order)
//   bit2 battery voltage (1 word)
//
// Upstream conversions (ported verbatim):
//   moisture at level k    = (word - 32768) / 100   [%]
//   temperature at level k = (word - 32768) / 100   [°C]
//   salinity at level k    = word - 100             [raw index, dimensionless]
//   battery voltage        = word / 1000            [V]
//
// Mapping: this is a multi-level profile probe, but the single-measurement
// vocabulary models one soil.* set, so the topmost/representative level (level
// 0) maps to soil.moisture (%) and soil.temperature (°C). The complete per-level
// readings are emitted as the camelCase extras `soilMoistureProfile`,
// `soilTemperatureProfile` and `soilSalinityProfile` (each entry carries its
// level index). The Decentlab "salinity" output is a raw, dimensionless sensor
// index — not electrical conductivity in dS/m — so it has no vocabulary key and
// is kept only in the profile extra. Battery voltage is reported by the device
// already in volts, so it maps directly to `battery`. The protocol version and
// device id (framing diagnostics the vocabulary does not model) are emitted as
// the camelCase extras `protocolVersion`/`deviceId`. soil.moisture is a bounded
// 0-100% percentage and soil.temperature is bounded >= -273.15 °C; if the
// representative level's value falls outside those bounds it is omitted from the
// normalized soil.* field but still recorded faithfully in the profile extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short: need at least 5 header bytes'] };
  }

  var version = bytes[0];
  if (version !== 2) {
    return { errors: ["protocol version " + version + " doesn't match v2"] };
  }

  var deviceId = u16be(bytes[1], bytes[2]);
  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table.
  var lengths = [18, 18, 1];

  var pos = 5;
  var words = [];
  var i;
  var f = flags;
  for (i = 0; i < lengths.length; i++) {
    if (f & 1) {
      var block = [];
      var j;
      for (j = 0; j < lengths[i]; j++) {
        if (pos + 1 >= bytes.length) {
          return { errors: ['payload too short: truncated sensor block'] };
        }
        block.push(u16be(bytes[pos], bytes[pos + 1]));
        pos += 2;
      }
      words[i] = block;
    }
    f >>= 1;
  }

  var data = {};
  data.protocolVersion = version;
  data.deviceId = deviceId;

  var moistureProfile = [];
  var temperatureProfile = [];
  var salinityProfile = [];

  // bit0 (levels 0-5) and bit1 (levels 6-11): each an 18-word block laid out as
  // 6 moisture words, then 6 temperature words, then 6 salinity words.
  var blockIndex;
  for (blockIndex = 0; blockIndex < 2; blockIndex++) {
    if (words[blockIndex]) {
      var w = words[blockIndex];
      var levelBase = blockIndex * 6;
      var k;
      for (k = 0; k < 6; k++) {
        var level = levelBase + k;
        moistureProfile.push({
          level: level,
          moisture: round((w[k] - 32768) / 100, 2)
        });
        temperatureProfile.push({
          level: level,
          temperature: round((w[6 + k] - 32768) / 100, 2)
        });
        salinityProfile.push({
          level: level,
          salinity: w[12 + k] - 100
        });
      }
    }
  }

  if (moistureProfile.length > 0) {
    data.soilMoistureProfile = moistureProfile;
    data.soilTemperatureProfile = temperatureProfile;
    data.soilSalinityProfile = salinityProfile;

    // Representative (topmost) level -> normalized soil.*. Only emit values that
    // fall within the vocabulary bounds.
    var soil = {};
    var topMoisture = moistureProfile[0].moisture;
    var topTemperature = temperatureProfile[0].temperature;
    if (topMoisture >= 0 && topMoisture <= 100) {
      soil.moisture = topMoisture;
    }
    if (topTemperature >= -273.15) {
      soil.temperature = topTemperature;
    }
    data.soil = soil;
  }

  // bit2: battery voltage (V, already volts).
  if (words[2]) {
    data.battery = round(words[2][0] / 1000, 3);
  }

  return { data: data };
}
