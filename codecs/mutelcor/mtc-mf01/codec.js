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
// its three connected switches into the low bits of this byte (0x01, 0x02,
// 0x04). Other opcodes do not carry the contact input and are reported as
// errors. The input voltage is reported as battery (V).
//
// Multi-channel shape (`channels[]`) — the three switch inputs are sub-sensor
// positions of one device reporting the same quantity (a dry-contact state), so
// each rides in the reserved `channels` array (see AUTHORING.md "Multi-channel
// devices") instead of the suffixed `switch1` / `switch2` / `switch3` extras
// this codec used to emit. One entry per switch bit, each carrying the
// `action.contactState` vocabulary key ("open" | "closed") with the convention
// unchanged from the pre-channels codec: a SET bit is a closed contact (contact
// made), a clear bit is open.
//
// Label scheme and renumbering — the labels are the vendor's own term for the
// input ("switch", as in the upstream field `[22] Switch State`) plus a
// zero-based index, so they are renumbered against the old one-based extras:
//   `switch0` = state bit 0x01 = old `switch1` AND the old top-level
//               `action.contactState` (the "primary" switch was both)
//   `switch1` = state bit 0x02 = old `switch2`
//   `switch2` = state bit 0x04 = old `switch3`
// The label `switch1` therefore means bit 1 here and meant bit 0 before — read
// the mask, not the digit, when comparing against the old output.
//
// The top-level `action.contactState` is REMOVED: the same leaf now lives in
// every entry, and AUTHORING forbids emitting one leaf both top-level and inside
// entries (downstream stores keep top-level readings under the empty channel
// label and would double-count the primary switch). The `analog-interface`
// category is still satisfied — it has no `requires`, only an `atLeastOne` list
// that includes `action.contactState`, and membership resolves through top-level
// `channels[]` entries. `battery` (the input voltage) is a whole-device reading
// and stays top-level; no leaf is emitted in both places.
//
// How many switches the frame carries (checked against the upstream snapshot):
// three, and the pre-channels codec dropped none of them. The upstream shared
// decoder reads opcode 6/7 as a single byte (`decoded.state = bytes[pos++]`) and
// gives meaning to only two whole-byte values in its translation table
// (`state_val` = {0: "Off", 1: "On"}, else "Unknown switch state (@)"), so
// upstream itself defines no third, fourth or fifth switch bit — the bit-packed
// reading of the low nibble is this device's multi-function behaviour (three
// external switch inputs on the MTC-MF01), and bits 0x08..0x80 are left
// undecoded because neither upstream nor the product's three-input spec assigns
// them an input. If a later datasheet revision documents a fourth switch bit,
// add a fourth entry (`switch3`) — the loop below is driven by the mask table.
//
// Sentinel policy: the switch-state byte carries NO presence/connected mask and
// the frame defines NO disconnected-switch sentinel, so an unwired switch input
// is indistinguishable from a wired-but-open contact: no value is treated as a
// sentinel and no entry is ever suppressed on its reading. (Contrast the shared
// Mutelcor *digital inputs* field on opcode 3, which does carry a low-nibble
// presence mask — that field is not part of this device's switch frame and is
// not decoded here.) A short frame cannot fabricate an open contact from
// `undefined` either: the guard below rejects a Switch frame with no state byte,
// so bytes[4] is always present when entries are built. `channels` is built
// lazily and only attached when it has entries, so a frame that produced no
// switch positions would omit the key rather than ship an empty array.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Switch-state bit per channels[] entry, in label order (`switch0` first).
var SWITCH_MASKS = [0x01, 0x02, 0x04];

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

  // One channels[] entry per switch input: bit 0x01 -> `switch0`, 0x02 ->
  // `switch1`, 0x04 -> `switch2`. Set bit = closed contact (contact made).
  var channels = [];
  for (var i = 0; i < SWITCH_MASKS.length; i += 1) {
    channels.push({
      channel: 'switch' + i,
      action: { contactState: (stateByte & SWITCH_MASKS[i]) ? 'closed' : 'open' }
    });
  }
  if (channels.length > 0) {
    data.channels = channels;
  }

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
