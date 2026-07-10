// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R309 (Wireless Wearable Emergency
// Button with Inactivity Detection). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r309.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// fPort 6 status frame (device id byte[1] == 0xD3 == 211, R309):
//   bytes[0]      frame marker (0x01 status)
//   bytes[1]      device type id (0xD3 == R309)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      emergency-alarm flag (button pressed) -> action.button.pressed
//                 with action.button.event "single"
//   bytes[5]      inactivity (no-activity) alarm flag -> extra `inactivityAlarm`
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
  if (bytes[1] !== 0xD3) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0xd3, R309)'] };
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

  // Byte 4: emergency-alarm flag == button pressed.
  var pressed = Boolean(bytes[4]);
  data.action = { button: { pressed: pressed } };
  if (pressed) {
    data.action.button.event = 'single';
  }

  // Byte 5: inactivity / no-activity alarm (device diagnostic).
  data.inactivityAlarm = Boolean(bytes[5]);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r309";
  }
  return result;
}
