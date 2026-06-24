// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RAKwireless WisBlock Kit 1 (Weather / Environment
// Monitor — RAK4631 base with RAK1906 BME680: air temperature, humidity,
// barometric pressure, and gas resistance; optional RAK1904 accelerometer).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire format
// (RAKwireless "Environment Monitoring" custom payload, data-type marker 0x01)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/rakwireless, the RAKwireless
// Standardized Payload Cayenne-LPP decoder; attributed in NOTICE) and the
// vendor's documented byte layout
// (https://docs.rakwireless.com/product-categories/wisblock/rak1906/quickstart/).
//
// Byte layout (all multi-byte fields big-endian / MSB-first):
//   [0]      = 0x01            data-type marker (Environment Monitoring)
//   [1..2]   = int16  temp     value / 100 -> air.temperature (degC)
//   [3..4]   = uint16 humidity value / 100 -> air.relativeHumidity (%)
//   [5..8]   = uint32 pressure value / 100 -> air.pressure (hPa)
//   [9..12]  = uint32 gas      Ohms        -> gasResistance (extra, no vocab key)
//   [13..18] = optional int16 x/y/z acceleration (value / 1000 g), RAK1904
//
// Gas resistance and acceleration have no normalized vocabulary key, so they are
// emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16be(hi, lo) {
  var v = ((hi << 8) | lo) & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32be(b0, b1, b2, b3) {
  return (b0 * 16777216 + (b1 << 16) + (b2 << 8) + b3) >>> 0;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 13) {
    return { errors: ['payload too short: expected at least 13 bytes'] };
  }
  if (bytes[0] !== 0x01) {
    return { errors: ['unrecognized data-type marker: ' + bytes[0]] };
  }

  var air = {};
  air.temperature = round(s16be(bytes[1], bytes[2]) / 100, 2);
  air.relativeHumidity = round((((bytes[3] << 8) | bytes[4]) & 0xffff) / 100, 2);
  air.pressure = round(u32be(bytes[5], bytes[6], bytes[7], bytes[8]) / 100, 2);

  var data = { air: air };
  data.gasResistance = u32be(bytes[9], bytes[10], bytes[11], bytes[12]);

  // Optional RAK1904 accelerometer (6 bytes: int16 x/y/z, 0.001 g per count).
  if (bytes.length >= 19) {
    data.acceleration = {
      x: round(s16be(bytes[13], bytes[14]) / 1000, 3),
      y: round(s16be(bytes[15], bytes[16]) / 1000, 3),
      z: round(s16be(bytes[17], bytes[18]) / 1000, 3)
    };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "rakwireless";
    result.data.model = "wisblock-kit1";
  }
  return result;
}
