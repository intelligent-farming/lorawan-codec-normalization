// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/dry-contacts-2
// (Adeunis "Dry Contact 2 - I/O Interface": 4-channel dry-contact input).
//
// Derivation: wire format understood from the upstream Apache-2.0 shared library
// (TheThingsNetwork/lorawan-devices vendor/adeunis/drycontacts_lib.js, resolved
// from dry-contacts-2.yaml -> drycontacts-codec -> uplinkDecoder.fileName,
// attributed in NOTICE). Normalization authored here; the upstream `decode()`
// bag is NOT copied.
//
// Frame model (byte[0] = frame code, byte[1] = status byte):
//   0x40 Dry Contacts 2 data carries the per-channel counters and states below.
//   Config/downlink-ack frames (0x10, 0x20, 0x2f, 0x33) are rejected.
// 0x40 data layout:
//   bytes[2..3]  channel A transition counter (big-endian uint16)
//   bytes[4..5]  channel B transition counter
//   bytes[6..7]  channel C transition counter
//   bytes[8..9]  channel D transition counter
//   byte[10]     current/previous states: bit0 A cur, bit1 A prev, bit2 B cur,
//                bit3 B prev, bit4 C cur, bit5 C prev, bit6 D cur, bit7 D prev
//                (true = ON/CLOSED, false = OFF/OPEN)
// Channel A current state maps to the vocabulary action.contactState; the other
// channels' states, previous states and transition counters are camelCase
// extras. Battery is reported only as a low-battery flag, not a value.

function contactState(flag) {
  return flag ? 'closed' : 'open';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var frameCode = bytes[0];

  if (frameCode !== 0x40) {
    return { errors: ['unsupported frame code 0x' + frameCode.toString(16) + ' (expected 0x40 data)'] };
  }
  if (bytes.length !== 11) {
    return { errors: ['expected 11-byte dry-contacts data frame, got ' + bytes.length] };
  }

  var status = bytes[1];
  var s = bytes[10];

  var data = {};
  data.action = { contactState: contactState(s & 0x01) };
  data.channelBContactState = contactState(s & 0x04);
  data.channelCContactState = contactState(s & 0x10);
  data.channelDContactState = contactState(s & 0x40);
  data.channelAPreviousState = contactState(s & 0x02);
  data.channelBPreviousState = contactState(s & 0x08);
  data.channelCPreviousState = contactState(s & 0x20);
  data.channelDPreviousState = contactState(s & 0x80);
  data.channelACount = (bytes[2] << 8) | bytes[3];
  data.channelBCount = (bytes[4] << 8) | bytes[5];
  data.channelCCount = (bytes[6] << 8) | bytes[7];
  data.channelDCount = (bytes[8] << 8) | bytes[9];
  data.lowBattery = Boolean(status & 0x02);
  data.configurationDone = Boolean(status & 0x01);
  data.frameCounter = (status & 0xe0) >> 5;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "dry-contacts-2";
  }
  return result;
}
