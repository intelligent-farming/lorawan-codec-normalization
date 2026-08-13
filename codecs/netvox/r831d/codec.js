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
// voltage (byte 3 is the first relay state, not a voltage byte) — so this codec
// emits no `battery`.
//
// The three digital inputs are the device's genuine input measurements, and they
// report the same quantity at three sub-sensor positions (three dry-contact
// terminals) of one device — so each rides in the reserved `channels` array (see
// AUTHORING.md "Multi-channel devices") rather than in the suffixed
// `contactState2` / `contactState3` extras this codec used to emit: one entry per
// terminal, labelled with the vendor's own term plus a zero-based index —
// `input0` (Netvox Input_1, bytes[6]), `input1` (Input_2, bytes[7]) and `input2`
// (Input_3, bytes[8]) — each carrying the `action.contactState` vocabulary key
// ("open" | "closed"). The state mapping is unchanged from the pre-channels
// codec: a non-zero input byte is a closed (connected) contact, zero is open.
// The entry labels are zero-based while Netvox's own field names are one-based,
// so the mapping is `input0` = Input_1 = bytes[6], and so on. `input0`/`input1`
// follows the label scheme of the Netvox 2-input dry-contact siblings (R311CA /
// R718J2), whose datasheets brand them "2-Input Dry Contact Interface"; the
// "2-Gang" branded products use `gang0`/`gang1` instead. Because
// `action.contactState` now lives only inside the entries and nowhere at the top
// level, no leaf is emitted in both places; the `analog-interface` category
// (atLeastOne includes `action.contactState`) is still satisfied, since
// membership resolves through top-level `channels[]` entries.
//
// Relay outputs stay TOP-LEVEL extras — a deliberate, reviewed exception. The
// relay states are surfaced as the diagnostic extras `relay1` / `relay2` /
// `relay3` (boolean, true = energized/ON) and are NOT converted to `channels[]`
// entries: a relay is actuator state the network server commanded, not a measured
// sub-sensor reading, and AUTHORING explicitly allows naming an extra for
// something that is not a measured position. Mixing the three outputs into the
// same `channels` array as the three inputs would also make an output
// indistinguishable from an input to a downstream flattener that treats every
// entry as telemetry. This is a policy call on outputs, not a settled
// convention: a reviewer may later want an output-position policy of its own
// (a separate reserved container, or an `outputs[]`-style extra) — which would
// supersede these three suffixed extras. Until then, only the measured input
// positions become channel entries.
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
//   bytes[6]      digital input-1 state -> channels[] entry `input0`
//   bytes[7]      digital input-2 state -> channels[] entry `input1`
//   bytes[8]      digital input-3 state -> channels[] entry `input2`
//   bytes[9..10]  unused
//
// Sentinel policy: this frame format defines NO disconnected-input sentinel.
// Upstream maps each input byte with a plain two-way test
// (`bytes[6] === 0x00 ? 'OFF' : 'ON'`) and reserves no third "terminal not
// wired" value, so an unwired terminal is indistinguishable from an open
// contact, no value is treated as a sentinel, and no input entry is ever
// suppressed on its reading. Nor can a short frame fabricate an open contact
// from `undefined`: the length guard below requires all 9 header+relay+input
// bytes — the last input byte, bytes[8], is inside the guard — so all three
// input bytes are present whenever a frame decodes, and all three entries are
// emitted unconditionally.
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
  // Not channels[] entries: an output is not a measured position (see header).
  data.relay1 = bytes[3] !== 0x00;
  data.relay2 = bytes[4] !== 0x00;
  data.relay3 = bytes[5] !== 0x00;

  // One channels[] entry per digital input terminal: bytes[6] = Netvox Input_1
  // (`input0`), bytes[7] = Input_2 (`input1`), bytes[8] = Input_3 (`input2`).
  data.channels = [
    { channel: 'input0', action: { contactState: contact(bytes[6]) } },
    { channel: 'input1', action: { contactState: contact(bytes[7]) } },
    { channel: 'input2', action: { contactState: contact(bytes[8]) } }
  ];

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
