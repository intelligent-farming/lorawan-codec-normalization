// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-RHC (High-Precision Air Temperature
// and Humidity Sensor with Radiation Shield for LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-rhc.js, attributed in
// NOTICE). The upstream decodeUplink emits raw Decentlab per-sensor objects;
// the per-sensor conversion formulas below are ported faithfully and the
// results are then mapped onto the shared normalized vocabulary.
//
// Mapping: air_temperature -> air.temperature; air_humidity ->
// air.relativeHumidity; battery_voltage (already volts) -> battery. The 32-bit
// sensor serial number (sensor_id), which the vocabulary does not model, is
// emitted as the camelCase extra `sensorId`. (The DL-RHC reports relative
// humidity and temperature only; it carries no dew-point or condensation
// channel on the wire, so none is emitted.)

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
  //   bit0 sensor_id + humidity + temperature (4 words), bit1 battery (1 word)
  var lengths = [4, 1];

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

  // bit0: 32-bit sensor serial number (extra), relative humidity (%) and
  // air temperature (°C). Upstream: sensor_id = x[0] + x[1] * 65536;
  // humidity = x[2] / 100; temperature = (x[3] - 32768) / 100.
  if (words[0]) {
    data.sensorId = words[0][0] + words[0][1] * 65536;
    air.relativeHumidity = round(words[0][2] / 100, 2);
    air.temperature = round((words[0][3] - 32768) / 100, 2);
    hasAir = true;
  }

  // bit1: battery voltage (V, already volts). Upstream: x[0] / 1000.
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
