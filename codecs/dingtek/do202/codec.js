// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dingtek DO202 (magnetic parking/vehicle
// occupancy sensor with onboard temperature & humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/do202.js, attributed in
// NOTICE). Decode ported faithfully from that reference; the normalization
// (vocabulary mapping) is authored here.
//
// The DO202 reports battery as VOLTS (centivolts on the wire), so `volt` maps
// to the vocabulary `battery` (V). Onboard temperature is a signed 8-bit °C
// value and humidity is an integer %; both map under `air`. The magnetometer
// axes, parking/level/magnet/battery alarm flags, frame counter, and the
// parameter-packet configuration fields have no vocabulary home and are
// emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16be(hi, lo) {
  var v = ((hi << 8) + lo) & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

function s8(value) {
  return value > 127 ? value - 256 : value;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort'] };
  }

  if (bytes.length === 23) {
    var data = {};

    // Battery: centivolts on the wire -> volts.
    data.battery = round(((bytes[9] << 8) + bytes[10]) / 100, 2);

    // Onboard environment (signed 8-bit °C, integer % RH).
    data.air = {
      temperature: s8(bytes[17]),
      relativeHumidity: bytes[18]
    };

    // Alarm flags (nibble booleans) — no vocabulary home.
    data.alarmPark = Boolean(bytes[7] >> 4);
    data.alarmLevel = Boolean(bytes[7] & 0x0f);
    data.alarmMagnet = Boolean(bytes[8] >> 4);
    data.alarmBattery = Boolean(bytes[8] & 0x0f);

    // Magnetometer axes (signed 16-bit, big-endian) — extras.
    data.xMagnet = s16be(bytes[11], bytes[12]);
    data.yMagnet = s16be(bytes[13], bytes[14]);
    data.zMagnet = s16be(bytes[15], bytes[16]);

    data.frameCounter = (bytes[19] << 8) + bytes[20];

    return { data: data };
  }

  if (bytes.length === 16 && bytes[3] === 0x03) {
    // Parameter/configuration packet — all device-specific extras.
    return {
      data: {
        firmware: bytes[5] + '.' + bytes[6],
        uploadInterval: bytes[7],
        detectInterval: bytes[8],
        magnetThreshold: (bytes[10] << 8) + bytes[11],
        batteryThreshold: bytes[12]
      }
    };
  }

  return { errors: ['wrong length'] };
}
