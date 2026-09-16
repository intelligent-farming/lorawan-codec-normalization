// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox RA10 (Wireless LoRa Valve keeper —
// relay/switch output). Data reports arrive on fPort 6.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/ra10.js, attributed
// in NOTICE). Normalization authored here; upstream decodeUplink is NOT copied.
//
// fPort 6 frame layout (device id byte[1] == 0x71 for RA10):
//   bytes[0]      report/frame marker (0x01)
//   bytes[1]      device type id (0x71 == RA10)
//   bytes[2]      report type; 0x00 is a version/date-code frame (no measurement)
//   bytes[3]      relay state; nonzero (ON) -> action.switch.state = true
// Config responses (fPort 7) carry no measurement and are reported as errors.

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (configuration response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 4) {
    return { errors: ['expected at least 4 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x71) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x71, RA10)'] };
  }
  if (bytes[2] === 0x00) {
    return { errors: ['device version frame (no measurement)'] };
  }

  var data = {};

  // Relay / valve state: ON (nonzero) -> true.
  data.action = { switch: { state: bytes[3] !== 0x00 } };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "ra10" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "ra10";
  }
  return result;
}
