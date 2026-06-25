// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-OPTOD (Optical Dissolved Oxygen
// and Temperature Sensor for LoRaWAN; water-quality probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-optod.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: the oxygen probe block (bit0) carries status, temperature, oxygen
// saturation, oxygen concentration and an alternate oxygen concentration.
// temperature (°C) -> water.temperature.current; oxygen_concentration (mg/L)
// -> water.dissolvedOxygen. oxygen_saturation (%) and the alternate oxygen
// concentration (ppm, identical magnitude to mg/L) are quantities the
// vocabulary does not model, emitted as the camelCase extras
// `oxygenSaturation` and `oxygenConcentrationPpm`. status is the camelCase
// extra `status`. battery_voltage (bit1, already volts) -> battery. protocol
// version and device id -> camelCase extras `protocolVersion` and `deviceId`.

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
  //   bit0 oxygen probe (5 words), bit1 battery (1 word)
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

  var water = {};
  var hasWater = false;

  // bit0: oxygen probe block. Five 16-bit words: status, temperature,
  // oxygen saturation, oxygen concentration, oxygen concentration (alt).
  if (words[0]) {
    data.status = words[0][0];

    // Temperature (°C), signed via upstream's (word - 32768) / 100.
    water.temperature = { current: round((words[0][1] - 32768) / 100, 2) };

    // Oxygen saturation (%); not in vocabulary -> camelCase extra.
    data.oxygenSaturation = round((words[0][2] - 32768) / 100, 2);

    // Dissolved oxygen concentration (mg/L), upstream (word - 32768) / 100.
    water.dissolvedOxygen = round((words[0][3] - 32768) / 100, 2);

    // Alternate oxygen concentration (ppm); duplicate magnitude not in
    // vocabulary -> camelCase extra.
    data.oxygenConcentrationPpm = round((words[0][4] - 32768) / 100, 2);

    hasWater = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasWater) {
    data.water = water;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-optod";
  }
  return result;
}
