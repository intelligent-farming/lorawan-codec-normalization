// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Mutelcor LoRa Multi-Function Device (mtc-mf01),
// which connects up to three external dry-contact switches and reports their
// state on change.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream decoder
// (TheThingsNetwork/lorawan-devices vendor/mutelcor/mutelcor.js, attributed in
// NOTICE). Upstream is a generic "LoRaButton" decoder; this module normalizes
// only the switch/contact state and input voltage, and does NOT copy upstream.
//
// Common Mutelcor frame:
//   byte0      = payload version
//   bytes[1..2]= voltage (battery/input), big-endian, hundredths of a volt
//   byte3      = opcode
// Switch opcode (6): byte4 = switch-state byte. The multi-function device packs
// up to three connected switches into the low bits of this byte. The primary
// switch (bit0) is normalized to action.contactState (1 -> "closed" contact
// made, 0 -> "open"); each connected switch bit is also exposed as an extra.
// Other opcodes do not carry the contact input and are reported as errors. The
// input voltage is reported as battery (V).

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

  var stateByte = bytes[4];
  var data = {};
  data.battery = voltage;
  data.action = { contactState: (stateByte & 0x01) ? 'closed' : 'open' };
  data.switch1 = (stateByte & 0x01) ? 1 : 0;
  data.switch2 = (stateByte & 0x02) ? 1 : 0;
  data.switch3 = (stateByte & 0x04) ? 1 : 0;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mutelcor";
    result.data.model = "mtc-mf01";
  }
  return result;
}
