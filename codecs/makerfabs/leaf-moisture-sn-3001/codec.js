// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs AgroSense Leaf Moisture SN-3001
// (air temperature + relative humidity + battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/leaf-moisture-sn-3001.js,
// attributed in NOTICE). Do NOT copy upstream normalization as our output.
//
// Wire layout (big-endian):
//   bytes[2]      battery, deci-volts  -> battery (V)
//   bytes[3]      "Significant" valid flag (0 = data invalid)
//   bytes[4..5]   relative humidity, deci-percent -> air.relativeHumidity (%)
//   bytes[6..7]   temperature, deci-°C, two's complement -> air.temperature (°C)
//   bytes[8..11]  reporting interval, milliseconds -> intervalSeconds (extra)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 12) {
    return { errors: ['payload too short: expected 12 bytes'] };
  }

  var significant = bytes[3];
  if (!significant) {
    return { errors: ['sensor reported data invalid (significant flag clear)'] };
  }

  var battery = round(bytes[2] / 10, 1);

  var humidity = round(((bytes[4] << 8) | bytes[5]) / 10, 1);

  var rawTemp = (bytes[6] << 8) | bytes[7];
  if (rawTemp >= 0x8000) {
    rawTemp -= 0x10000;
  }
  var temperature = round(rawTemp / 10, 1);

  var intervalSeconds =
    (bytes[8] * 16777216 + bytes[9] * 65536 + bytes[10] * 256 + bytes[11]) / 1000;

  return {
    data: {
      air: {
        temperature: temperature,
        relativeHumidity: humidity
      },
      battery: battery,
      intervalSeconds: intervalSeconds
    }
  };
}
