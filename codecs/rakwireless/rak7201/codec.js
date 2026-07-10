// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the RAKwireless RAK7201 (WisNode Button 4K, a
// remote wireless trigger with four user-defined keys).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoders
// (TheThingsNetwork/lorawan-devices vendor/rakwireless/decoder-rak7201.js and
// the shipped community variant wisnode_button_4k_RAK7201V2_payload_decoder,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// decodeUplink.
//
// The device sends a single byte identifying which key was pressed. The
// community decoder documents the raw values as Button1=49, Button2=50,
// Button3=51, Button4=52 (ASCII '1'..'4'), i.e. buttonId = bytes[0] - 48. The
// stock upstream decoder subtracts 64 instead, which does not match those
// documented values; this codec uses the documented mapping.
//
//   bytes[0]  key id (49..52) -> extra `buttonId` (1..4)
//
// Any valid key byte is a press event: action.button.pressed = true,
// action.button.event = "single". No battery is reported in this payload.

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['expected at least 1 byte, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[0] < 49 || bytes[0] > 52) {
    return { errors: ['unknown key byte ' + bytes[0] + ' (expected 49..52)'] };
  }

  var data = {};
  data.buttonId = bytes[0] - 48;
  data.action = { button: { pressed: true, event: 'single' } };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "rakwireless";
    result.data.model = "rak7201";
  }
  return result;
}
