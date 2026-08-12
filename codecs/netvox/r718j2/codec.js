// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718J2 (Wireless 2-Input Dry Contact
// Interface). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da2_r718db2_r718f2.js,
// shared across that Netvox family (R718J2 is device id 0x43) and attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// The R718J2 detects the closure/disconnection of two external dry contacts.
// Both contacts report the same quantity at two sub-sensor positions of one
// device, so each rides in the reserved `channels` array (see AUTHORING.md
// "Multi-channel devices") rather than in a suffixed `contactState2` extra: one
// entry per contact, labelled with the vendor's own term plus a zero-based
// index — `input0` (Netvox channel 1, bytes[4]) and `input1` (Netvox channel 2,
// bytes[5]) — each carrying the `action.contactState` vocabulary key
// ("open" | "closed"). The state mapping is unchanged from the pre-channels
// codec: a non-zero status byte is a closed (connected) contact, zero is open.
// `battery` and the `lowBattery` flag are whole-device readings and stay
// top-level; no leaf is emitted in both places.
//
// Label scheme note: this Netvox 2-position fPort-6 family deliberately does
// NOT use one label word throughout — each codec follows the vendor's own term
// for that product. Netvox brands the R718J2 (and R311CA) a "2-Input Dry
// Contact Interface", so its positions are `input0`/`input1`; the sibling
// R718F2 / R718LB2 are branded "2-Gang" open/close detectors and use
// `gang0`/`gang1`. The difference tracks the datasheets, not an inconsistency.
//
// Sentinel policy: this frame format defines NO disconnected-contact sentinel.
// The shared upstream decoder passes both state bytes straight through
// (`status1` = bytes[4], `status2` = bytes[5]) with no reserved "not connected"
// value, and the report layout reserves none either — every value is either
// zero (open) or non-zero (closed) — so no value is treated as a sentinel and
// neither entry is ever suppressed on its reading. Nor can a short frame
// fabricate one: the length guard below requires all 6 header+state bytes, so
// both state bytes are always present when a frame decodes and both entries are
// emitted unconditionally.
//
// fPort 6 frame layout (device id byte[1] == 0x43 for R718J2):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x43 == R718J2)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      channel-1 dry-contact state -> channels[] `input0`
//   bytes[5]      channel-2 dry-contact state -> channels[] `input1`
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
  if (bytes[1] !== 0x43) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x43, R718J2)'] };
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

  // One channels[] entry per dry-contact terminal: byte 4 = Netvox channel 1
  // (`input0`), byte 5 = Netvox channel 2 (`input1`).
  data.channels = [
    { channel: 'input0', action: { contactState: contact(bytes[4]) } },
    { channel: 'input1', action: { contactState: contact(bytes[5]) } }
  ];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718j2";
  }
  return result;
}
