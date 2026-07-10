// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718H (Wireless Pulse Counter
// Interface, single input). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718h.js, shared by
// the R718H (device id 0x1F) and R718H2 (device id 0x3F) pulse counters and
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// decodeUplink.
//
// The R718H is a single-input dry-contact / S0 pulse counter: each data frame
// carries the count accumulated over the reporting interval, mapped to the
// analog-interface vocabulary key `pulse.count`.
//
// fPort 6 frame layout (device id byte[1] == 0x1F for R718H):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x1F == R718H)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4..5]   pulse count over the reporting interval, 16-bit big-endian
//                 -> pulse.count
//   bytes[6..10]  unused for R718H (second channel exists only on R718H2)
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
  if (bytes[1] !== 0x1F) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x1f, R718H)'] };
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

  // Bytes 4..5: pulse count over the reporting interval (16-bit big-endian).
  var pulse = {};
  pulse.count = (bytes[4] << 8) | bytes[5];
  data.pulse = pulse;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718h";
  }
  return result;
}
