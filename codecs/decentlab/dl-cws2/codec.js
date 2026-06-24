// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-CWS2 (High-Precision Winter Road
// Maintenance Sensor with Radiation Shield for LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-cws2.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: air_temperature (the main, high-precision air sensor) ->
// air.temperature; air_humidity -> air.relativeHumidity; battery_voltage
// (already volts) -> battery. The device has no barometric pressure sensor.
// Sensor readings the vocabulary does not model (the secondary
// radiation-shield air temperature/humidity, surface temperature, dew point,
// tilt angle, internal sensor temperature) are emitted as camelCase extras.

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

  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table:
  //   bit0 radiation-shield temp/humidity (2),
  //   bit1 surface/air temp+humidity/dew point/angle/sensor temp (6),
  //   bit2 battery (1)
  var lengths = [2, 6, 1];

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

  // bit0: secondary radiation-shield air temperature (°C) and humidity (%).
  // No vocabulary key for the redundant radiation-shield channel -> extras.
  if (words[0]) {
    data.airTemperatureRadiationShield = round(175 * words[0][0] / 65535 - 45, 2);
    data.airHumidityRadiationShield = round(100 * words[0][1] / 65535, 2);
  }

  // bit1: surface temperature, primary air temperature + humidity, dew point,
  // tilt angle, internal sensor temperature.
  if (words[1]) {
    data.surfaceTemperature = round((words[1][0] - 32768) / 100, 2);
    air.temperature = round((words[1][1] - 32768) / 100, 2);
    air.relativeHumidity = round((words[1][2] - 32768) / 100, 2);
    data.dewPoint = round((words[1][3] - 32768) / 100, 2);
    data.angle = words[1][4] - 32768;
    data.sensorTemperature = round((words[1][5] - 32768) / 100, 2);
    hasAir = true;
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-cws2";
  }
  return result;
}
