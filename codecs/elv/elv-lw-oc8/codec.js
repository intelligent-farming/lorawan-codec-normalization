// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elv/elv-lw-oc8 (ELV-LW-OC8 Open Collector 8-fold:
// eight open-collector output channels whose on/off states are reported).
// Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 ELV decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-oc8.js, attributed in
// NOTICE). The uplink (fPort 10) is a TLV stream of typed records; upstream
// flattens each channel into ch1..ch8 (0/1) plus version/tx_reason/supply.
// This module walks the same records and authors the normalized vocabulary.
// Upstream normalization is never copied.
//
// TLV record types (fPort 10):
//   0x01 app version    : 3 bytes  -> appVersion (extra, "Vx.y.z")
//   0x02 bootloader ver : 3 bytes  -> blVersion (extra)
//   0x03 tx reason      : 1 byte   -> txReason (extra, event name)
//   0x04 supply voltage : 2 bytes  mV -> supplyVoltage (V extra; mV / 1000)
//   0x07 output states  : count(1)=1 then 1 bitfield byte
//                         bit b -> open-collector channel b (channels[] `oc<b>`)
//   0x08 interval       : 1 byte   -> interval (extra)
//   0x09 contact iface  : 1 byte   -> contactInterfaceEnabled (boolean extra)
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). The eight open-collector channels are sub-sensor positions of one
// device all carrying the same quantity — their on/off state — so each rides in
// the reserved `channels` array rather than in the suffixed `contactState2` ...
// `contactState8` extras this codec used to emit: one entry per channel, each
// carrying the `action.contactState` vocabulary key. Labels are the vendor's own
// term plus a zero-based index — `oc0` ... `oc7`, "OC" being ELV's own
// abbreviation for the open-collector channels in the product name (ELV-LW-OC8,
// "Open Collector 8fold"); the labels are zero-based while ELV and the upstream
// decoder number the channels ch1..ch8, so `oc0` is ELV channel 1 (bitfield bit
// 0) and `oc7` is channel 8 (bit 7). The open/closed convention is unchanged
// from the pre-channels codec: a set bit means the collector is on, reported as
// 'closed', and a clear bit as 'open'. Every bit the 0x07 record carries gets an
// entry; the 2..8 states used to be booleans, and are now the same 'closed' /
// 'open' strings as channel 1 so all eight positions read alike.
//
// OUTPUT CHANNELS — a deliberate, documented EXCEPTION to this repo's policy on
// actuator outputs. These eight channels are outputs (open-collector drivers the
// network server switches), and the general policy on this branch is that
// actuator output state stays a TOP-LEVEL suffixed extra rather than becoming a
// channels entry — see netvox/r831d's `relay1` / `relay2` / `relay3` and the
// enginko/mcf88 boards' `output1` ... `output8`, all of which keep their outputs
// top-level next to the measured input positions that do become entries. This
// device is the exception because the eight output STATES are its ENTIRE
// reading: it reports nothing else measurable (only supply voltage, versions and
// config), so leaving them as `contactState2` ... `contactState8` would preserve
// exactly the suffixed-extra anti-pattern the `channels` array exists to remove,
// and would leave the device with a single positional reading at the top level
// and seven invisible siblings. The state of an output is still a reading —
// `action.contactState` describes the terminal, not the command that set it.
// This is a policy call, not a settled convention: a reviewer may later unify
// the two treatments under a dedicated output-position policy (a separate
// reserved container, or an `outputs[]`-style extra), which would supersede both
// this device's entries and the suffixed extras on r831d/mcf88.
//
// Contact-interface record (0x09) — investigated, and it is NOT a second
// positional bank. `contactInterfaceEnabled` is a single boolean config byte
// that reports whether the board's contact-interface mode is switched on; in
// that mode the same eight OC terminals are additionally watched as contacts,
// which is what the shared tx-reason list's INPUT_1_EVENT ... INPUT_8_EVENT
// entries (0x03..0x0A) name — a state change on terminal n triggering an uplink.
// The payload defines NO separate input-state record: the full record set is
// 0x01, 0x02, 0x03, 0x04, 0x07, 0x08, 0x09, and 0x07 ("Output states") is the
// only bitfield of terminal states in it. So there is exactly one bank of eight
// positions, whose state the `oc0` ... `oc7` entries carry in either mode, and
// `contactInterfaceEnabled` stays a top-level whole-device config extra (a mode
// flag, not a per-position reading). If a future firmware adds a second
// terminal-state record, its positions would need their own labels.
//
// Whole-device readings stay TOP-LEVEL and are never duplicated inside an entry:
// `supplyVoltage`, `appVersion`, `blVersion`, `txReason`, `interval` and
// `contactInterfaceEnabled`. Because `action.contactState` now lives only inside
// the entries, no leaf is emitted in both places; the `analog-interface`
// category (atLeastOne includes `action.contactState`) is still satisfied, since
// membership resolves through top-level `channels[]` entries.
//
// Sentinel policy: this frame format defines NO disconnected/fault sentinel for
// a channel. The 0x07 record is a plain 8-bit field in which every bit is a
// valid on/off state, and the payload carries neither a per-channel fault code
// nor a population mask, so no bit is treated as a sentinel and no entry is ever
// suppressed on its value. An unpopulated terminal simply reads permanently
// 'open'. `channels` is built lazily and OMITTED entirely when a frame carries
// no 0x07 record (a config-only uplink, e.g. version + interval records) or when
// 0x07 arrives with a count byte other than 1 — the only length encoding the
// vendor's format defines is count == 1, so any other count is skipped rather
// than guessed at, exactly as upstream does.
//
// An unknown record type is a hard parser error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var TX_REASON = [
  'UNDEFINED_EVENT', 'TIMER_EVENT', 'USER_BUTTON_EVENT', 'INPUT_1_EVENT',
  'INPUT_2_EVENT', 'INPUT_3_EVENT', 'INPUT_4_EVENT', 'INPUT_5_EVENT',
  'INPUT_6_EVENT', 'INPUT_7_EVENT', 'INPUT_8_EVENT', 'APP_EVENT',
  'CYCLIC_EVENT', 'TIMEOUT_EVENT', 'DOWNLINK_ACK_EVENT', 'DOWNLINK_ERROR_EVENT'
];

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 10)'] };
  }
  if (!b || b.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  // Latest 0x07 output-states bitfield, -1 while none has been seen. Held in a
  // variable (rather than pushed on sight) so a repeated 0x07 record overwrites
  // the positions, as upstream's key assignment does, instead of duplicating
  // their labels.
  var ocBits = -1;
  var i = 0;

  while (i < b.length) {
    var type = b[i];

    if (type === 0x01) {
      data.appVersion = 'V' + b[i + 1] + '.' + b[i + 2] + '.' + b[i + 3];
      i += 4;
    } else if (type === 0x02) {
      data.blVersion = 'V' + b[i + 1] + '.' + b[i + 2] + '.' + b[i + 3];
      i += 4;
    } else if (type === 0x03) {
      var r = b[i + 1];
      data.txReason = r < TX_REASON.length ? TX_REASON[r] : 'UNKNOWN_EVENT';
      i += 2;
    } else if (type === 0x04) {
      data.supplyVoltage = round(((b[i + 1] << 8) | b[i + 2]) / 1000, 3);
      i += 3;
    } else if (type === 0x07) {
      // count byte then, if 1, a bitfield of the 8 channel states: bit ch is
      // open-collector channel ch (`oc<ch>`), set = collector on = 'closed'.
      var count = b[i + 1];
      if (count === 1) {
        ocBits = b[i + 2];
        i += 3;
      } else {
        i += 2;
      }
    } else if (type === 0x08) {
      data.interval = b[i + 1];
      i += 2;
    } else if (type === 0x09) {
      data.contactInterfaceEnabled = Boolean(b[i + 1]);
      i += 2;
    } else {
      return { errors: ['unknown ELV-LW-OC8 record type 0x' + type.toString(16)] };
    }
  }

  // One channels[] entry per open-collector channel: bitfield bit ch is channel
  // `oc<ch>`, set = collector on = contact 'closed'. Attached only when this
  // frame actually carried a 0x07 record.
  if (ocBits >= 0) {
    var channels = [];
    var ch;
    for (ch = 0; ch < 8; ch++) {
      channels.push({
        channel: 'oc' + ch,
        action: { contactState: ((ocBits >> ch) & 0x01) ? 'closed' : 'open' }
      });
    }
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elv";
    result.data.model = "elv-lw-oc8";
  }
  return result;
}
