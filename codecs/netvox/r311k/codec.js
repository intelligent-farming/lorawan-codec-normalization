// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R311K (Wireless Tilt Sensor). Data
// reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/r718da_r718db_r718j_r718lb_r718mba.js, shared by a
// family of binary-status Netvox nodes and attributed in NOTICE). Author the
// normalization here; do NOT copy upstream decodeUplink.
//
// Category: `motion`, NOT `tilt`. Despite the "Tilt Sensor" product name, the
// R311K firmware payload reports only a single discrete status byte (byte[4]),
// not a continuous inclination angle or per-axis tilt. Per the tilt-category
// definition ("A discrete tilt-alarm event belongs in `motion`"), this maps to
// the discrete movement event action.motion.detected. There are no tilt.angle /
// tilt.x/y/z values to recover from this wire format.
//
// fPort 6 frame layout (device id byte[1] == 0x9E for R311K):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x9E == R311K)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      tilt/movement status; nonzero == tilted/moved
//                 -> action.motion.detected (boolean). The raw byte is also
//                 surfaced as the camelCase extra `tiltStatus`.
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
  if (bytes[1] !== 0x9E) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x9e, R311K)'] };
  }

  // bytes[2] is the report-type discriminator; 0x00 is a device-info frame.
  if (bytes[2] === 0x00) {
    return { errors: ['device information frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Byte 4: discrete tilt/movement status; nonzero == tilted/moved.
  data.action = { motion: { detected: bytes[4] !== 0x00 } };
  data.tiltStatus = bytes[4];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r311k" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r311k";
  }
  return result;
}
