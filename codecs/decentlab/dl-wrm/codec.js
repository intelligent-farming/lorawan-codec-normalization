// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-WRM (Winter Road Maintenance
// Sensor for LoRaWAN — air temperature/humidity plus surface and head
// temperature probes).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-wrm.js, attributed in
// NOTICE). The upstream decodeUplink emits raw Decentlab per-sensor objects;
// the per-sensor conversion formulas below are ported faithfully and the
// results are then mapped onto the shared normalized vocabulary.
//
// Mapping: air_temperature -> air.temperature; air_humidity ->
// air.relativeHumidity; battery_voltage (already volts) -> battery. Sensor
// readings the vocabulary does not model (surface and head temperature, the
// two road-probe channels) are emitted as camelCase extras.

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

  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table:
  //   bit0 air temp/humidity (2), bit1 surface/head temp (2), bit2 battery (1)
  var lengths = [2, 2, 1];

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
  var air = {};
  var hasAir = false;

  // bit0: air temperature (°C) and relative humidity (%)
  if (words[0]) {
    air.temperature = round(175 * words[0][0] / 65535 - 45, 2);
    air.relativeHumidity = round(100 * words[0][1] / 65535, 2);
    hasAir = true;
  }

  // bit1: surface and head temperature probes (°C, extras — no vocabulary key)
  if (words[1]) {
    data.surfaceTemperature = round((words[1][0] - 1000) / 10, 2);
    data.headTemperature = round((words[1][1] - 1000) / 10, 2);
  }

  // bit2: battery voltage (V, already volts)
  if (words[2]) {
    data.battery = round(words[2][0] / 1000, 3);
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
