// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for STMicroelectronics NUCLEO-WL55JC2 (LoRaWAN
// development board sensor demo).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/stmicroelectronics/nucleo-wl55jc.js,
// attributed in NOTICE).
//
// fPort 2 payload (>= 7 bytes, big-endian fields):
//   bytes[0] bit0  red LED status (1 = ON, 0 = OFF) — an actuator state flag,
//                  NOT a light-intensity reading. Upstream labels this field
//                  "light"; it is emitted here as the camelCase extra
//                  `redLedStatus` and is deliberately NOT mapped to
//                  air.lightIntensity (which the vocabulary defines as lux).
//   bytes[1..2]    barometric pressure, deci-hPa  -> air.pressure (hPa)
//   bytes[3]       internal temperature, signed int8 °C -> air.temperature
//   bytes[4..5]    relative humidity, deci-%      -> air.relativeHumidity
//   bytes[6]       battery DAC count: ((count * 1200 / 254) + 1800) mV
//                  -> `battery` in volts (the vocabulary `battery` is volts).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s8(b) {
  return b > 0x7f ? b - 0x100 : b;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }

  var bytes = input.bytes;
  if (!bytes || bytes.length < 7) {
    return { errors: ['payload too short: expected at least 7 bytes'] };
  }

  var air = {};
  air.pressure = round(u16be(bytes[1], bytes[2]) / 10, 1);
  air.temperature = s8(bytes[3]);
  air.relativeHumidity = round(u16be(bytes[4], bytes[5]) / 10, 1);

  var data = {};
  data.air = air;
  data.battery = round((((bytes[6] * 1200) / 254) + 1800) / 1000, 3);
  data.redLedStatus = (bytes[0] & 0x01) ? 'ON' : 'OFF';

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "stmicroelectronics";
    result.data.model = "nucleo-wl55jc2";
  }
  return result;
}
