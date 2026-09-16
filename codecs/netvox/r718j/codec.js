// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718J (Wireless Dry Contact
// Interface, single input). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/r718da_r718db_r718j_r718lb_r718mba.js, shared across
// that Netvox family and attributed in NOTICE). Author the normalization here;
// do NOT copy upstream decodeUplink.
//
// The R718J detects the open/closed state of a single external dry contact. The
// status byte is normalized to the analog-interface vocabulary key
// `action.contactState` ("open" | "closed"): a non-zero status is a closed
// (connected) contact, zero is open (disconnected).
//
// fPort 6 frame layout (device id byte[1] == 0x21 for R718J):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x21 == R718J)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      dry-contact state (0 = open, non-zero = closed)
//                 -> action.contactState
//   bytes[5..10]  unused
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
  if (!bytes || bytes.length < 5) {
    return { errors: ['expected at least 5 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x21) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x21, R718J)'] };
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

  // Byte 4: dry-contact state -> action.contactState.
  var action = {};
  action.contactState = bytes[4] !== 0x00 ? 'closed' : 'open';
  data.action = action;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r718j" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718j";
  }
  return result;
}
