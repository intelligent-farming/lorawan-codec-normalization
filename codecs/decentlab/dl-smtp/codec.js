// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-SMTP (Soil Moisture and Temperature
// Profile sensor for LoRaWAN) — a multi-depth profile probe reporting soil
// moisture and soil temperature at up to 8 discrete depths plus battery.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-smtp.js, attributed in
// NOTICE). The per-channel conversion formulas below are ported faithfully from
// the upstream SENSORS table; the upstream decodeUplink emits one raw object per
// depth (`soil_moisture_at_depth_N` / `soil_temperature_at_depth_N`). The
// results are then mapped onto the shared normalized vocabulary.
//
// Mapping: this is a multi-depth profile probe, but the single-measurement
// vocabulary models one soil.* set, so the topmost/representative depth (depth
// 0) maps to soil.moisture (%) and soil.temperature (°C); the complete per-depth
// readings are emitted as the camelCase extras `soilMoistureProfile` and
// `soilTemperatureProfile` (each entry carries its depth index). Battery voltage
// is reported by the device already in volts, so it maps directly to `battery`.
// The protocol version and device id (framing diagnostics the vocabulary does
// not model) are emitted as the camelCase extras `protocolVersion`/`deviceId`.
//
// Upstream conversions (ported verbatim):
//   soil moisture at depth k    = (word - 2500) / 500
//   soil temperature at depth k = (word - 32768) / 100   [°C]
//   battery voltage             = word / 1000            [V]
// A disconnected channel reads moisture -5 and temperature -327.68; such values
// fall outside the vocabulary bounds for soil.moisture/soil.temperature, so a
// depth whose representative value is out of range is omitted from the
// normalized soil.* fields but still recorded faithfully in the profile extras.

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
  // upstream SENSORS table:
  //   bit0 soil profile (16 words: 8 depths, moisture+temperature interleaved)
  //   bit1 battery voltage (1 word)
  var lengths = [16, 1];

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

  // bit0: 8-depth soil moisture (%) + temperature (°C) profile, interleaved.
  if (words[0]) {
    var profileWords = words[0];
    var moistureProfile = [];
    var temperatureProfile = [];
    var k;
    for (k = 0; k < 8; k++) {
      var moisture = round((profileWords[k * 2] - 2500) / 500, 3);
      var temperature = round((profileWords[k * 2 + 1] - 32768) / 100, 2);
      moistureProfile.push({ depth: k, moisture: moisture });
      temperatureProfile.push({ depth: k, temperature: temperature });
    }
    data.soilMoistureProfile = moistureProfile;
    data.soilTemperatureProfile = temperatureProfile;

    // Representative (topmost) depth -> normalized soil.*. Only emit values that
    // fall within the vocabulary bounds (soil.moisture is a 0-100% percentage;
    // soil.temperature is >= -273.15 °C). A disconnected probe reports
    // out-of-range sentinels (-5, -327.68) which must not be forced into the
    // bounded vocabulary fields.
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

  // bit1: battery voltage (V, already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  return { data: data };
}
