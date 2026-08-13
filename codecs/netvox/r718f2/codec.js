// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718F2 (Wireless 2-Gang Reed Switch
// Open/Close Detection Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/r718da2_r718db2_r718f2.js, attributed in NOTICE).
// Author the normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x3E == 62 == R718F2) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`), bytes[4] is the gang-1 reed
// switch state and bytes[5] the gang-2 reed switch state (0 = closed,
// 1 = open).
//
// This is a 2-gang contact sensor: both reed switches report the same quantity
// at two sub-sensor positions of one device, so each rides in the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") rather than in a
// suffixed `contactState2` extra: one entry per gang, labelled with the
// vendor's own term plus a zero-based index — `gang0` (Netvox channel 1,
// bytes[4]) and `gang1` (Netvox channel 2, bytes[5]) — each carrying the
// `action.contactState` vocabulary key ("open" | "closed"). The state mapping is
// unchanged from the pre-channels codec: 0 is closed, non-zero is open (note
// this is the opposite polarity from the R311CA / R718J2 dry-contact siblings,
// which is why each codec keeps its own mapping). The reed switch is a contact
// sensor, so the state is emitted as action.contactState and NOT action.motion
// (a known upstream copy-paste bug for door sensors). `battery` and the
// `lowBattery` flag are whole-device readings and stay top-level; no leaf is
// emitted in both places.
//
// Label scheme note: this Netvox 2-position fPort-6 family deliberately does
// NOT use one label word throughout — each codec follows the vendor's own term
// for that product. Netvox brands the R718F2 (and R718LB2) a "2-Gang" open/close
// detection sensor, so its positions are `gang0`/`gang1`; the sibling R311CA /
// R718J2 are branded "2-Input Dry Contact Interface" and use `input0`/`input1`.
// The difference tracks the datasheets, not an inconsistency.
//
// Sentinel policy: this frame format defines NO disconnected-gang sentinel. The
// shared upstream decoder passes both state bytes straight through
// (`status1` = bytes[4], `status2` = bytes[5]) with no reserved "not connected"
// value, and the report layout reserves none either — every value is either
// zero (closed) or non-zero (open) — so no value is treated as a sentinel and
// neither entry is ever suppressed on its reading. Nor can a short frame
// fabricate one: the length guard below requires all 6 header+state bytes, so
// both state bytes are always present when a frame decodes and both entries are
// emitted unconditionally.
//
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contactState(raw) {
  // Netvox reed switch: 0 = closed, non-zero = open.
  return raw === 0 ? 'closed' : 'open';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // One channels[] entry per gang: byte 4 = Netvox channel 1 (`gang0`),
  // byte 5 = Netvox channel 2 (`gang1`).
  data.channels = [
    { channel: 'gang0', action: { contactState: contactState(bytes[4]) } },
    { channel: 'gang1', action: { contactState: contactState(bytes[5]) } }
  ];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718f2";
  }
  return result;
}
