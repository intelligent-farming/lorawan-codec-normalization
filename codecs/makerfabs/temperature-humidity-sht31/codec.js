// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs Temperature & Humidity SHT31
// (AgroSense Temperature & Humidity Sensor, SHT31 element).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/temperature-humidity-sht31.js,
// attributed in NOTICE). Ported from that decoder's decodeUplink; do NOT copy
// upstream normalizeUplink.
//
// Wire layout (fixed 7 bytes, big-endian):
//   bytes[0..1]  reserved / sequence (ignored upstream)
//   bytes[2]     battery, deci-volts         -> battery (V)              = b2 / 10
//   bytes[3..4]  humidity, deci-percent      -> air.relativeHumidity (%) = u16 / 10
//   bytes[5..6]  temperature, deci-degC (s16) -> air.temperature (degC)  = s16 / 10
//
// The SHT31 reports battery as a VOLTAGE (e.g. 3.1 V), so it maps to the
// vocabulary `battery` key directly (not `batteryPercent`).

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

  var data = {
    battery: round(bat, 1),
    air: {
      temperature: round(temp, 1),
      relativeHumidity: round(humi, 1)
    }
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "temperature-humidity-sht31";
  }
  return result;
}
