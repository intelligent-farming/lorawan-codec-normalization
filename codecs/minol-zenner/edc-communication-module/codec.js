// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Minol-Zenner EDC Communication Module for water
// meters -- a coil/pulse counter reporting the attached water meter's index.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/minol-zenner/
// edc-communication-module.js, attributed in NOTICE). Upstream emits a flat
// status bag plus a raw `meter_values` array; this module normalizes the
// primary cumulative reading to the pulse vocabulary and does NOT copy upstream.
//
// Payload layout:
//   byte0            = status summary bits:
//     bit0 removal detection, bit1 battery low, bit2 battery end-of-life,
//     bit3 hardware error, bit5 coil manipulation.
//   bytes[1..]       = one or more 32-bit big-endian meter values.
// The first meter value is the cumulative coil/pulse count. The metered
// quantity (water volume) is defined by the attached meter, so it maps to the
// generic pulse vocabulary:
//   first meter value -> pulse.total
// Status flags are exposed as camelCase extras. At least one full 32-bit value
// (5 bytes total) is required.

function u32be(bytes, off) {
  return ((bytes[off] * 16777216) + (bytes[off + 1] * 65536) + (bytes[off + 2] * 256) + bytes[off + 3]);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short (' + (bytes ? bytes.length : 0) + '), expected status byte + a 32-bit meter value'] };
  }

  var status = bytes[0];
  var data = {};
  data.pulse = { total: u32be(bytes, 1) };
  data.removalDetection = (status & 0x01) !== 0;
  data.batteryLow = (status & 0x02) !== 0;
  data.batteryEndOfLife = (status & 0x04) !== 0;
  data.hardwareError = (status & 0x08) !== 0;
  data.coilManipulation = (status & 0x20) !== 0;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "minol-zenner", model: "edc-communication-module" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "minol-zenner";
    result.data.model = "edc-communication-module";
  }
  return result;
}
