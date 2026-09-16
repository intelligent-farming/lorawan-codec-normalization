// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Radio Bridge RBS301-1 (Single Push Button;
// used as a panic button / PERS / remote control).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/radio-bridge/radio_bridge_packet_decoder.js, attributed in NOTICE).
// Author the normalization here; do NOT copy upstream decodeUplink.
//
// Radio Bridge packet layout (event-type dispatched on byte[1], not fPort):
//   bytes[0]      protocol version (high nibble) + packet counter (low nibble)
//   bytes[1]      event type; 0x06 == PUSH BUTTON event
//   bytes[2]      button id (0x03 == the single button on RBS301-1)
//   bytes[3]      button state: 0=Pressed, 1=Released, 2=Held
//
// Only the push-button event carries a press; this codec decodes 0x06 and
// reports all other event types (reset, supervisory, tamper, link-quality,
// device-info, downlink-ack) as errors since they are not a press. Battery is
// only reported in the supervisory event, so it is not available here.
//
// Press-state -> action.button:
//   Pressed  -> pressed true,  event "single"
//   Held     -> pressed true,  event "hold"
//   Released -> pressed false, event "release"

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 4) {
    return { errors: ['expected at least 4 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x06) {
    return { errors: ['unsupported event type 0x' + bytes[1].toString(16) + ' (expected 0x06, push button; no press to decode)'] };
  }

  var data = {};
  data.protocolVersion = (bytes[0] >> 4) & 0x0f;
  data.packetCounter = bytes[0] & 0x0f;
  data.buttonId = bytes[2];

  var state = bytes[3];
  if (state === 0) {
    data.action = { button: { pressed: true, event: 'single' } };
  } else if (state === 2) {
    data.action = { button: { pressed: true, event: 'hold' } };
  } else if (state === 1) {
    data.action = { button: { pressed: false, event: 'release' } };
  } else {
    return { errors: ['unknown button state ' + state] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "radio-bridge", model: "rbs301-1" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "radio-bridge";
    result.data.model = "rbs301-1";
  }
  return result;
}
