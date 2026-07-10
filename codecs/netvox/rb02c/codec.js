// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox RB02C (Wireless 3-Gang Push Button).
// Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/rb02b.js, shared with
// the RB02B 2-gang and attributed in NOTICE). Author the normalization here; do
// NOT copy upstream decodeUplink.
//
// fPort 6 status frame (device id byte[1] == 0xA7 == 167, RB02C):
//   bytes[0]      frame marker (0x01 status)
//   bytes[1]      device type id (0xA7 == RB02C)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      gang-1 (key 1) press flag  -> primary action.button.pressed
//   bytes[5]      gang-2 (key 2) press flag  -> extra `gang2Pressed`
//   bytes[6]      gang-3 (key 3) press flag  -> extra `gang3Pressed`
//
// Three gangs: the primary gang (key 1) drives action.button.pressed and
// action.button.event "single"; action.button.count is the number of gangs
// currently pressed. Per-gang flags are kept as camelCase extras.
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
  if (!bytes || bytes.length < 7) {
    return { errors: ['expected at least 7 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0xA7) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0xa7, RB02C)'] };
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

  // Bytes 4-6: per-gang press flags. Gang 1 is the primary button.
  var gang1 = Boolean(bytes[4]);
  var gang2 = Boolean(bytes[5]);
  var gang3 = Boolean(bytes[6]);
  var count = (gang1 ? 1 : 0) + (gang2 ? 1 : 0) + (gang3 ? 1 : 0);

  data.action = { button: { pressed: gang1, count: count } };
  if (count > 0) {
    data.action.button.event = 'single';
  }

  data.gang2Pressed = gang2;
  data.gang3Pressed = gang3;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "rb02c";
  }
  return result;
}
