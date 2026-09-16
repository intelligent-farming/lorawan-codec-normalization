// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Jeng-IoT Buzzon Button (wireless button for
// outdoor public-space use).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/jeng-iot/buzzon.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// Both the normal message (fPort 1) and the heartbeat (fPort 2) share a layout:
//   bytes[0..1]  cumulative short-press count, little-endian
//   bytes[2..3]  cumulative long-press count, little-endian
//   bytes[4..5]  reserved
//   bytes[6..7]  node voltage as a 2-byte "sflt16" fraction, little-endian;
//                node voltage = sflt16 * 10  (volts)
//
// The counts are cumulative totals, not per-interval, so an instantaneous
// pressed state cannot be derived; the short-press total is reported as
// action.button.count and the long-press total as the extra `longPressCount`.
// Voltage is normalized to `battery` (V).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Decode the MCCI "sflt16" 2-byte float: bit15 sign, bits14-11 exponent,
// bits10-0 mantissa. Result is in the open interval (-1.0, 1.0).
function sflt162f(rawSflt16) {
  rawSflt16 &= 0xFFFF;
  if (rawSflt16 === 0x8000) {
    return 0;
  }
  var sSign = (rawSflt16 & 0x8000) ? -1 : 1;
  var exp1 = (rawSflt16 >> 11) & 0xF;
  var mant1 = (rawSflt16 & 0x7FF) / 2048.0;
  return sSign * mant1 * Math.pow(2, exp1 - 15);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 1 && input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 1 or 2)'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data = {};

  var shortPresses = bytes[0] + (bytes[1] * 256);
  var longPresses = bytes[2] + (bytes[3] * 256);

  data.action = { button: { count: shortPresses } };
  data.longPressCount = longPresses;

  var voltage = sflt162f(bytes[6] + (bytes[7] * 256)) * 10;
  data.battery = round(voltage, 3);

  data.heartbeat = input.fPort === 2;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "jeng-iot", model: "buzzon" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "jeng-iot";
    result.data.model = "buzzon";
  }
  return result;
}
