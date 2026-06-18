// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs ATH20 (Air Temperature & Humidity
// Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/ath20.js, attributed in
// NOTICE). Ported from the upstream decodeUplink: byte 2 is battery in tenths
// of a volt; bytes 3-4 are humidity in tenths of a percent (big-endian); bytes
// 5-6 are temperature in tenths of a degree Celsius (big-endian, two's
// complement). Do NOT copy upstream normalizeUplink.
//
// Battery is reported as a VOLTAGE here (tenths of a volt), so it maps to the
// vocabulary `battery` (volts) directly.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
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

  return {
    data: {
      battery: round(bat, 1),
      air: {
        temperature: round(temp, 1),
        relativeHumidity: round(humi, 1)
      }
    }
  };
}
