// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for STMicroelectronics NUCLEO-WL55JC1 (LoRaWAN
// dev-board demo sensor application).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed-layout demo uplink on fPort 2) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/stmicroelectronics/nucleo-wl55jc.js, attributed in NOTICE).
//
// fPort 2 fixed layout (15-byte demo payload):
//   byte 0      : status flags, bit0 = red LED state (ON/OFF)
//   byte 1..2   : barometric pressure, big-endian, deci-hPa  -> air.pressure (hPa)
//   byte 3      : internal temperature, signed int8 (deg C)  -> air.temperature
//   byte 4..5   : relative humidity, big-endian, deci-%      -> air.relativeHumidity
//   byte 6      : battery, (raw * 1200 / 254 + 1800) mV      -> battery (V)
//
// The red LED is an actuator state, not an illuminance reading, so it is emitted
// as the camelCase extra `redLedOn` (boolean) rather than air.lightIntensity.
// Battery is reported in millivolts here; the vocabulary's `battery` is volts, so
// it is converted to volts.

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
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }
  if (!bytes || bytes.length < 7) {
    return { errors: ['payload too short: expected at least 7 bytes on fPort 2'] };
  }

  var air = {};
  air.pressure = round(u16be(bytes[1], bytes[2]) / 10, 1);
  air.temperature = s8(bytes[3]);
  air.relativeHumidity = round(u16be(bytes[4], bytes[5]) / 10, 1);

  var data = {};
  data.air = air;
  data.battery = round((((bytes[6] * 1200) / 254) + 1800) / 1000, 3);
  data.redLedOn = (bytes[0] & 0x01) === 0x01;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "stmicroelectronics";
    result.data.model = "nucleo-wl55jc1";
  }
  return result;
}
