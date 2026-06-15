// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-LP8P (CO2, Temperature, Humidity
// and Barometric Pressure Sensor for LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-lp8p.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: air_temperature -> air.temperature; air_humidity ->
// air.relativeHumidity; barometric_pressure (Pa) -> air.pressure (hPa, /100,
// atmospheric); co2_concentration (ppm) -> air.co2; battery_voltage (already
// volts) -> battery. Sensor readings the vocabulary does not model (barometer
// temperature, CO2 LPF concentration, CO2 sensor temperature, capacitor
// voltages, CO2 sensor status, raw IR readings) are emitted as camelCase
// extras.

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
  //   bit0 temp/humidity (2), bit1 barometer (2), bit2 CO2 (8), bit3 battery (1)
  var lengths = [2, 2, 8, 1];

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
    air.temperature = round(175.72 * words[0][0] / 65536 - 46.85, 2);
    air.relativeHumidity = round(125 * words[0][1] / 65536 - 6, 2);
    hasAir = true;
  }

  // bit1: barometer temperature (°C, extra) + barometric pressure (Pa -> hPa)
  if (words[1]) {
    data.barometerTemperature = round((words[1][0] - 5000) / 100, 2);
    air.pressure = round(words[1][1] * 2 / 100, 2);
    hasAir = true;
  }

  // bit2: CO2 concentration (ppm) + diagnostics
  if (words[2]) {
    air.co2 = words[2][0] - 32768;
    data.co2ConcentrationLpf = words[2][1] - 32768;
    data.co2SensorTemperature = round((words[2][2] - 32768) / 100, 2);
    data.capacitorVoltage1 = round(words[2][3] / 1000, 3);
    data.capacitorVoltage2 = round(words[2][4] / 1000, 3);
    data.co2SensorStatus = words[2][5];
    data.rawIrReading = words[2][6];
    data.rawIrReadingLpf = words[2][7];
    hasAir = true;
  }

  // bit3: battery voltage (V, already volts)
  if (words[3]) {
    data.battery = round(words[3][0] / 1000, 3);
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
