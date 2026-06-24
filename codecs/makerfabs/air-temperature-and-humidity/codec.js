// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Makerfabs AgroSense Air Temperature and
// Humidity Sensor (AHT20 element).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/air-temperature-and-humidity.js,
// attributed in NOTICE). Do NOT copy upstream normalization.
//
// Ported from upstream decodeUplink (fixed-layout payload):
//   bytes[0..1] uint16 BE  packet sequence number (commented out upstream; not emitted)
//   bytes[2]    uint8       battery voltage x10 -> battery (V) (e.g. 0x24=36 -> 3.6 V)
//   bytes[3..4] uint16 BE   relative humidity x10 -> air.relativeHumidity (%)
//   bytes[5..6] int16  BE   temperature x10 (two's complement) -> air.temperature (°C)
//
// Battery is reported as VOLTS on this device (byte/10), so it maps to the
// vocabulary `battery` (V) directly -- not batteryPercent.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 7) {
    return { errors: ['payload too short: expected at least 7 bytes'] };
  }

  var bat = bytes[2] / 10.0;
  var humi = (bytes[3] * 256 + bytes[4]) / 10.0;

  var temp = bytes[5] * 256 + bytes[6];
  if (temp >= 0x8000) {
    temp -= 0x10000;
  }
  temp = temp / 10.0;

  var data = {};
  data.battery = round(bat, 1);
  data.air = {
    temperature: round(temp, 1),
    relativeHumidity: round(humi, 1)
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "air-temperature-and-humidity";
  }
  return result;
}
