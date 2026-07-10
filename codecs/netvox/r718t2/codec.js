// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718T2 (Wireless 2-Input Push Button
// Interface). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718t2.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// fPort 6 status frame (device id byte[1] == 0x48 == 72, R718T2):
//   bytes[0]      frame marker (0x01 status)
//   bytes[1]      device type id (0x48 == R718T2)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      input-1 alarm / press flag  -> extra `input1Pressed`
//   bytes[5]      input-2 alarm / press flag  -> extra `input2Pressed`
//
// Two independent inputs: the aggregate press is mapped to
// action.button.pressed (true when either input is active) with
// action.button.count = number of inputs currently active; the per-input flags
// are kept as camelCase extras.
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
  if (!bytes || bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x48) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x48, R718T2)'] };
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

  // Bytes 4-5: per-input press flags.
  var input1 = Boolean(bytes[4]);
  var input2 = Boolean(bytes[5]);
  var count = (input1 ? 1 : 0) + (input2 ? 1 : 0);
  var pressed = count > 0;

  data.action = { button: { pressed: pressed, count: count } };
  if (pressed) {
    data.action.button.event = 'single';
  }

  data.input1Pressed = input1;
  data.input2Pressed = input2;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718t2";
  }
  return result;
}
