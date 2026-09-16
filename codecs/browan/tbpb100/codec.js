// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Browan / TABS Push Button (TBPB100). Data
// reports arrive on fPort 147.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/tbpb100.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// fPort 147 frame layout:
//   bytes[0] bit0   button status (1 = pressed) -> action.button.pressed
//   bytes[1] low    battery nibble: voltage = (25 + (bytes[1] & 0x0f)) / 10 V
//   bytes[2] 0x7f   board temperature: (bytes[2] & 0x7f) - 32  (degrees C)
//                   -> extra `temperatureBoard`
//
// An all-zero / empty payload carries no measurement and is reported as an
// error (upstream silently returns an empty object).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 147) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 147)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['expected at least 3 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var allZero = true;
  for (var i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    return { errors: ['empty payload (no measurement)'] };
  }

  var data = {};

  // Byte 0 bit0: button pressed.
  var pressed = (bytes[0] & 0x01) === 1;
  data.action = { button: { pressed: pressed } };
  if (pressed) {
    data.action.button.event = 'single';
  }

  // Byte 1 low nibble: battery voltage.
  data.battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);

  // Byte 2: board temperature (device diagnostic).
  data.temperatureBoard = (bytes[2] & 0x7f) - 32;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "browan", model: "tbpb100" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "browan";
    result.data.model = "tbpb100";
  }
  return result;
}
