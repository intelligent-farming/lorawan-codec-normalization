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
// Mapping: a multi-level profile probe. Each connected level becomes one
// entry in the reserved `channels` array (see AUTHORING.md "Multi-channel
// devices"), labelled `level0`..`level11` after the wire level index and
// carrying that level's soil.moisture (%), soil.temperature (°C), and the
// camelCase extra `salinityIndex` — the Decentlab "salinity" output is a raw,
// dimensionless sensor index, not electrical conductivity in dS/m, so it has
// no vocabulary key. Whole-device battery voltage is reported already in
// volts and stays top-level as `battery`. Physical depth in centimetres is
// NOT in the payload and varies by probe length (3-12 sensor Drill & Drop
// variants exist), so no per-entry soil.depth is emitted. The protocol
// version and device id (framing diagnostics the vocabulary does not model)
// are emitted as the camelCase extras `protocolVersion`/`deviceId`.
//
// A disconnected level reads sentinel word 0 for moisture and temperature
// (-327.68 after conversion, outside the vocabulary bounds: soil.moisture
// 0-100 %, soil.temperature >= -273.15 °C). Out-of-range values are dropped
// per level; a level with no in-range soil value gets no channels entry (its
// salinityIndex, -100 on a disconnected level, is garbage without the soil
// readings and is dropped with it); the `channels` key is omitted when no
// level is connected.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
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

  // bit0 (levels 0-5) and bit1 (levels 6-11): each an 18-word block laid out as
  // 6 moisture words, then 6 temperature words, then 6 salinity words. One
  // channels entry per connected level; disconnected sentinels are dropped per
  // value and an entry with no in-range soil value is omitted.
  var channels = [];
  var blockIndex;
  for (blockIndex = 0; blockIndex < 2; blockIndex++) {
    if (words[blockIndex]) {
      var w = words[blockIndex];
      var levelBase = blockIndex * 6;
      var k;
      for (k = 0; k < 6; k++) {
        var moisture = round((w[k] - 32768) / 100, 2);
        var temperature = round((w[6 + k] - 32768) / 100, 2);
        var soil = {};
        if (moisture >= 0 && moisture <= 100) {
          soil.moisture = moisture;
        }
        if (temperature >= -273.15) {
          soil.temperature = temperature;
        }
        if (soil.moisture !== undefined || soil.temperature !== undefined) {
          channels.push({
            channel: 'level' + (levelBase + k),
            soil: soil,
            salinityIndex: w[12 + k] - 100
          });
        }
      }
    }
  }
  if (channels.length > 0) {
    data.channels = channels;
  }

  // bit2: battery voltage (V, already volts).
  if (words[2]) {
    data.battery = round(words[2][0] / 1000, 3);
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-sdd";
  }
  return result;
}
