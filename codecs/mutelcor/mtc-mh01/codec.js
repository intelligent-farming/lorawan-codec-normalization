// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Mutelcor LoRa Manhole Sensor (mtc-mh01), a
// dry-contact open/close detector for manhole covers and external doors.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream decoder
// (TheThingsNetwork/lorawan-devices vendor/mutelcor/mutelcor.js, attributed in
// NOTICE). Upstream is a generic "LoRaButton" decoder emitting descriptive
// strings; this module normalizes only the switch/contact state and the input
// voltage, and does NOT copy upstream.
//
// Common Mutelcor frame:
//   byte0      = payload version
//   bytes[1..2]= voltage (battery/input), big-endian, hundredths of a volt
//   byte3      = opcode
// The manhole sensor's contact state is carried by the Switch opcode (6):
//   byte4      = switch state (0 or 1)
// Convention: an open manhole/door drives the switch active, so state 1 maps to
// action.contactState "open" and state 0 to "closed". Other opcodes
// (heartbeat, alarm, measurements, ...) do not carry the contact input and are
// reported as errors. The input voltage is reported as battery (V).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 4) {
    return { errors: ['payload too short for a Mutelcor frame'] };
  }

  var voltage = round(((bytes[1] << 8) | bytes[2]) / 100, 2);
  var opcode = bytes[3];

  if (opcode !== 6) {
    return { errors: ['opcode ' + opcode + ' is not a Switch/contact frame'] };
  }
  if (bytes.length < 5) {
    return { errors: ['Switch frame missing state byte'] };
  }

  var state = bytes[4];
  var data = {};
  data.battery = voltage;
  data.action = { contactState: state ? 'open' : 'closed' };
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mutelcor";
    result.data.model = "mtc-mh01";
  }
  return result;
}
