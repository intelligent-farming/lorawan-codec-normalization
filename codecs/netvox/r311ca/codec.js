// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R311CA (Wireless 2-Input Dry Contact
// Interface). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da2_r718db2_r718f2.js,
// shared across that Netvox family (R311CA is device id 0x4C) and attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// The R311CA detects the open/closed state of two external dry contacts.
// Channel 1 maps to the analog-interface vocabulary key `action.contactState`
// ("open" | "closed"); channel 2 is the camelCase extra `contactState2`. A
// non-zero status is a closed (connected) contact, zero is open.
//
// fPort 6 frame layout (device id byte[1] == 0x4C for R311CA):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x4C == R311CA)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      channel-1 dry-contact state -> action.contactState
//   bytes[5]      channel-2 dry-contact state -> extra contactState2
//   bytes[6..10]  unused
//
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contact(b) {
  return b !== 0x00 ? 'closed' : 'open';
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
  if (bytes[1] !== 0x4C) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x4c, R311CA)'] };
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

  // Byte 4: channel-1 dry-contact state -> action.contactState.
  var action = {};
  action.contactState = contact(bytes[4]);
  data.action = action;

  // Byte 5: channel-2 dry-contact state -> extra contactState2.
  data.contactState2 = contact(bytes[5]);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r311ca";
  }
  return result;
}
