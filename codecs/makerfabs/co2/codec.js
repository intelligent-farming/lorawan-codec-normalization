// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs CO2 (Carbon Dioxide Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/co2.js, attributed in
// NOTICE). Ported from the upstream decodeUplink: bytes 0-1 are an unused
// counter (commented out upstream); byte 2 is battery in tenths of a volt;
// bytes 3-4 are CO2 concentration in ppm (big-endian). Upstream reports no
// temperature or humidity. Do NOT copy upstream normalizeUplink.
//
// Battery is reported as a VOLTAGE here (tenths of a volt), so it maps to the
// vocabulary `battery` (volts) directly. CO2 maps to air.co2 (ppm).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short: expected at least 5 bytes'] };
  }

  var bat = bytes[2] / 10.0;
  var co2 = bytes[3] * 256 + bytes[4];

  return {
    data: {
      battery: round(bat, 1),
      air: {
        co2: co2
      }
    }
  };
}
