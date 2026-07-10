// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718H2 (Wireless 2-Input Pulse
// Counter Interface). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718h.js, shared by
// the R718H (device id 0x1F) and R718H2 (device id 0x3F) pulse counters and
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// decodeUplink.
//
// The R718H2 is a two-input dry-contact / S0 pulse counter. Channel 1 maps to
// the analog-interface vocabulary key `pulse.count`; the second channel is the
// camelCase extra `pulseCount2` (the vocabulary models only a single pulse
// input per device).
//
// fPort 6 frame layout (device id byte[1] == 0x3F for R718H2):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x3F == R718H2)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4..5]   channel-1 pulse count, 16-bit big-endian -> pulse.count
//   bytes[6..7]   channel-2 pulse count, 16-bit big-endian -> extra pulseCount2
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
  if (bytes[1] !== 0x3F) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x3f, R718H2)'] };
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

  // Bytes 4..5: channel-1 pulse count (16-bit big-endian).
  var pulse = {};
  pulse.count = (bytes[4] << 8) | bytes[5];
  data.pulse = pulse;

  // Bytes 6..7: channel-2 pulse count -> extra pulseCount2.
  data.pulseCount2 = (bytes[6] << 8) | bytes[7];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718h2";
  }
  return result;
}
