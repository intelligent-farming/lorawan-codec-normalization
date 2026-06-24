// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-PHEHT (pH, ORP/redox and
// Temperature Sensor for LoRaWAN; soil/water pH + redox + temperature probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-pheht.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: the probe block (bit0) carries status, temperature, pH, redox and
// the raw pH electrode millivolts. temperature (°C) -> soil.temperature;
// ph -> soil.pH. redox / ORP (mV) and the pH electrode raw mV are quantities
// the vocabulary does not model, emitted as the camelCase extras `redox` and
// `phMv`. status is the camelCase extra `status`. battery_voltage (bit1, already
// volts) -> battery. protocol version and device id -> camelCase extras
// `protocolVersion` and `deviceId`.

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
  // upstream SENSORS table:
  //   bit0 pH/redox/temperature probe (5 words), bit1 battery (1 word)
  var lengths = [5, 1];

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

  var soil = {};
  var hasSoil = false;

  // bit0: probe block. Five 16-bit words: status, temperature, pH, redox, pH-mV.
  if (words[0]) {
    data.status = words[0][0];

    // Temperature (°C), signed via upstream's (word - 32768) / 100.
    soil.temperature = round((words[0][1] - 32768) / 100, 2);

    // pH (dimensionless), upstream (word - 32768) / 100.
    soil.pH = round((words[0][2] - 32768) / 100, 2);

    // Redox / ORP (mV); derived quantity not in vocabulary -> camelCase extra.
    data.redox = round((words[0][3] - 32768) / 10, 1);

    // pH electrode raw millivolts; not in vocabulary -> camelCase extra.
    data.phMv = round((words[0][4] - 32768) / 10, 1);

    hasSoil = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasSoil) {
    data.soil = soil;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-pheht";
  }
  return result;
}
