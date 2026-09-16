// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Mutelcor LoRa Panic Button with
// Confirmation (MTC-PB01).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mutelcor/mutelcor.js, the shared
// Mutelcor LoRaButton decoder, attributed in NOTICE). Author the normalization
// here; do NOT copy upstream decodeUplink.
//
// Mutelcor LoRaButton common header:
//   bytes[0]        payload version
//   bytes[1..2]     battery / input voltage, big-endian, in 0.01 V
//   bytes[3]        opcode: 0 = Heartbeat, 1 = Alarm (button press)
// Alarm (opcode 1) minimal frame:
//   bytes[4]        button bitmask (bit N -> button N+1)
//
// A panic press is the Alarm opcode: action.button.pressed = true,
// action.button.event "single", action.button.count = number of buttons in the
// mask. The heartbeat opcode reports pressed = false. The raw opcode and the
// list of pressed button numbers are kept as camelCase extras. Other opcodes
// (measurements, config, etc.) are not press telemetry and error out.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function buttonsFromMask(mask) {
  var list = [];
  for (var i = 0; i < 8; i++) {
    if (mask & (1 << i)) {
      list.push(i + 1);
    }
  }
  return list;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 4) {
    return { errors: ['expected at least 4 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data = {};
  data.payloadVersion = bytes[0];
  data.battery = round(((bytes[1] * 256) + bytes[2]) / 100, 2);

  var opcode = bytes[3];
  data.opcode = opcode;

  if (opcode === 1) {
    var mask = bytes.length > 4 ? bytes[4] : 0;
    var buttons = buttonsFromMask(mask);
    data.buttons = buttons;
    data.action = { button: { pressed: true, event: 'single', count: buttons.length } };
    return { data: data };
  }
  if (opcode === 0) {
    data.action = { button: { pressed: false } };
    return { data: data };
  }

  return { errors: ['unsupported opcode ' + opcode + ' (not a button press or heartbeat)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "mutelcor", model: "mtc-pb01" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mutelcor";
    result.data.model = "mtc-pb01";
  }
  return result;
}
