// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-BLG (Black Globe Temperature Sensor
// for LoRaWAN): a black-globe thermistor probe used to estimate radiant heat
// load / mean radiant temperature. The primary measurement is the black-globe
// temperature in °C, so this device maps to the `temperature` category
// (top-level `temperature`).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported faithfully from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-blg.js,
// attributed in NOTICE). The per-sensor conversion formulas below are ported
// verbatim from the upstream SENSORS table; the results are then mapped onto
// the shared normalized vocabulary. Upstream normalizeUplink is NOT copied.
//
// Mapping (flag bit order, LSB first):
//   bit0 thermistor block (2 words, x[0]/x[1] form a 24-bit ratiometric count):
//     - voltage_ratio      = ((x0 + x1*65536) / 8388608 - 1) / 2   (dimensionless)
//     - thermistor_resistance = 1000 / voltage_ratio - 41000        (Ω)
//     - temperature (Steinhart-Hart on the resistance) -> °C  ->  `temperature`
//     voltage_ratio and thermistor_resistance are not modelled by the
//     vocabulary, so they are emitted as camelCase extras.
//   bit1 battery (1 word): x[0] / 1000 -> V (already volts) -> `battery`.
// Protocol header fields are emitted as the extras protocolVersion / deviceId.

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

  // Word counts per sensor block, in flag-bit order (LSB first):
  //   bit0 thermistor (2 words), bit1 battery (1 word).
  var lengths = [2, 1];

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

  var hasTemperature = false;

  // bit0: thermistor block -> black-globe temperature (°C).
  if (words[0]) {
    var x0 = words[0][0];
    var x1 = words[0][1];

    var ratio = ((x0 + x1 * 65536) / 8388608 - 1) / 2;
    var resistance = 1000 / ratio - 41000;
    var temperature =
      1 /
        (0.0008271111 +
          0.000208802 * Math.log(resistance) +
          0.000000080592 * Math.pow(Math.log(resistance), 3)) -
      273.15;

    data.temperature = round(temperature, 2);
    data.voltageRatio = round(ratio, 6);
    data.thermistorResistance = round(resistance, 2);
    hasTemperature = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (!hasTemperature) {
    return { errors: ['no temperature field in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "decentlab", model: "dl-blg" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-blg";
  }
  return result;
}
