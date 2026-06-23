// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Browan TBWL100 (Tabs Water Leak Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/tbwl100.js, attributed in
// NOTICE). Ported from that upstream decodeUplink; the normalization here is
// authored for this module — do NOT treat upstream normalization as our output.
//
// Uplinks arrive on FPort 106 with a fixed 5-byte layout:
//   byte 0  status flags — bit 0 is the water-leak/flood state (1 = leak
//           detected, 0 = dry); bit 5 = temperature-changed event flag;
//           bit 6 = humidity-changed event flag.
//   byte 1  battery: a 4-bit level (low nibble) mapped to volts as
//           (25 + level) / 10, yielding 2.5 V .. 4.0 V, which matches the
//           vocabulary's `battery` (volts), so it is emitted there directly.
//   byte 2  internal board temperature, °C: (val & 0x7f) - 32.
//   byte 3  relative humidity, %.
//   byte 4  water-probe temperature, °C: (val & 0x7f) - 32. This is the
//           device's own probe reading and maps to water.temperature.current.
//
// The leak bit maps to the boolean vocabulary key `water.leak`. The board
// temperature, humidity, and the two change-event flags have no vocabulary key
// and are emitted as camelCase extras.
//
// Upstream returns a bare {} for an empty/all-zero payload; that violates this
// module's output contract (never return bare {}), so an empty payload is
// reported as an error instead.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  var allZero = true;
  var i;
  for (i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (bytes.length === 0 || allZero) {
    return { errors: ['empty payload'] };
  }

  if (input.fPort !== 106) {
    return { errors: ['unknown FPort'] };
  }

  if (bytes.length < 5) {
    return { errors: ['payload too short'] };
  }

  var leak = (bytes[0] & 0x01) === 1;
  var temperatureChanged = (bytes[0] >> 5) & 0x01;
  var humidityChanged = (bytes[0] >> 6) & 0x01;
  var battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);
  var boardTemperature = (bytes[2] & 0x7f) - 32;
  var humidity = bytes[3];
  var temperature = (bytes[4] & 0x7f) - 32;

  return {
    data: {
      battery: battery,
      boardTemperature: round(boardTemperature, 1),
      relativeHumidity: round(humidity, 1),
      temperatureChanged: temperatureChanged,
      humidityChanged: humidityChanged,
      water: {
        leak: leak,
        temperature: {
          current: round(temperature, 1)
        }
      }
    }
  };
}
