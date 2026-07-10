// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718KA2 (Wireless 2-Input 4-20mA
// Current Meter Interface). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718ka.js, shared by
// the R718KA (device id 0x22) and R718KA2 (device id 0x44) and attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// The R718KA2 measures two 4-20 mA current loops. Each channel's reading is
// split into an integer-milliamp part and a fractional (0.1 mA) part; the true
// loop current is their sum. Channel 1 maps to the analog-interface vocabulary
// key `analog.current` (mA); channel 2 is the camelCase extra `current2` (mA).
//
// fPort 6 frame layout (device id byte[1] == 0x44 for R718KA2):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x44 == R718KA2)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      channel-1 loop current, integer mA
//   bytes[5]      channel-2 loop current, integer mA
//   bytes[6]      channel-1 fractional current, 0.1 mA
//   bytes[7]      channel-2 fractional current, 0.1 mA
//                 (analog.current = bytes[4] + bytes[6] / 10;
//                  current2       = bytes[5] + bytes[7] / 10)
//   bytes[8..10]  unused
//
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (configuration response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x44) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x44, R718KA2)'] };
  }
  if (bytes[2] === 0x00) {
    return { errors: ['device information frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Channel 1 = byte4 (mA) + byte6 (0.1 mA) -> analog.current (mA).
  var analog = {};
  analog.current = round(bytes[4] + bytes[6] / 10, 1);
  data.analog = analog;

  // Channel 2 = byte5 (mA) + byte7 (0.1 mA) -> extra current2 (mA).
  data.current2 = round(bytes[5] + bytes[7] / 10, 1);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718ka2";
  }
  return result;
}
