// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R831D (Multifunctional Control Box
// with three relay outputs and three digital inputs). Data reports arrive on
// fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r831.js, shared by the
// R831A/B/C/D family; R831D is device id 0xB0, attributed in NOTICE). Author
// the normalization here; do NOT copy upstream decodeUplink.
//
// The R831D is a mains-powered control box: it drives three relay outputs and
// reads three dry-contact digital inputs. Its data frame carries NO battery
// voltage (byte 3 is the first relay state, not a voltage byte). The digital
// inputs are the device's genuine input measurements, so the first input maps
// to the analog-interface vocabulary key `action.contactState` ("open" |
// "closed") and the remaining two are the camelCase extras `contactState2` and
// `contactState3`. The relay OUTPUT states are actuator status, not an input
// measurement; they are surfaced as diagnostic extras `relay1`/`relay2`/
// `relay3` (boolean, true = energized/ON). A non-zero input byte is a closed
// (connected) contact; zero is open.
//
// Note: the sibling R831C (device id 0xAD) carries only the three relay outputs
// and no digital inputs, so it has no decodable input measurement and is not
// authored in this repo.
//
// fPort 6 frame layout (device id byte[1] == 0xB0 for R831D):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0xB0 == R831D)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      relay-1 output state (0 = OFF, non-zero = ON) -> extra relay1
//   bytes[4]      relay-2 output state -> extra relay2
//   bytes[5]      relay-3 output state -> extra relay3
//   bytes[6]      digital input-1 state -> action.contactState
//   bytes[7]      digital input-2 state -> extra contactState2
//   bytes[8]      digital input-3 state -> extra contactState3
//   bytes[9..10]  unused
//
// Config responses (fPort 7) carry no measurement and are reported as errors.

function contact(b) {
  return b !== 0x00 ? 'closed' : 'open';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (configuration response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 9) {
    return { errors: ['expected at least 9 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0xB0) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0xb0, R831D)'] };
  }
  if (bytes[2] === 0x00) {
    return { errors: ['device information frame (no measurement)'] };
  }

  var data = {};

  // Bytes 3..5: relay OUTPUT states (actuator status) -> diagnostic extras.
  data.relay1 = bytes[3] !== 0x00;
  data.relay2 = bytes[4] !== 0x00;
  data.relay3 = bytes[5] !== 0x00;

  // Byte 6: digital input-1 state -> action.contactState.
  var action = {};
  action.contactState = contact(bytes[6]);
  data.action = action;

  // Bytes 7..8: digital input-2/3 states -> extras.
  data.contactState2 = contact(bytes[7]);
  data.contactState3 = contact(bytes[8]);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r831d";
  }
  return result;
}
