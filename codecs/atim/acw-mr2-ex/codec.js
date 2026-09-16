// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-MR2-EX (Smart Metering: up to 2 pulse-meter
// channels; each channel configurable as a cumulative pulse index or as a dry
// contact / Boolean state). Category: analog-interface.
//
// Ported/normalized from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The MR2-EX emits the legacy "ancien produit" metering frames, dispatched
// upstream by frame_type_ancien() and shaped by decode_trame_ancien() +
// postProcessAncienCompteur0_15()/postProcessEntrerAncien(). We author the
// normalization here; upstream normalizeUplink/postProcess output is never reused.
//
// Wire format (byte[0] = frame type):
//   0x50 counters 1 & 2        : [0x50, c1(4), c2(4)]
//   0x51 counters 3 & 4        : [0x51, c3(4), c4(4)]
//   0x42 digital inputs        : [0x42, in_lo, in_hi]  (Boolean-state channels)
//   0x52 inputs + counter 1    : [0x52, in_lo, in_hi, c1(4)]
//   0x4F inputs + counters 1,2 : [0x4F, in_lo, in_hi, c1(4), c2(4)]
//   0x5E inputs + N counters   : [0x5E, in_lo, in_hi, c0(4), c1(4), ...]
//   0x14 standard meter frame  : [0x14, wirecut, c1(4), c2(4)]
//   0x01 life frame            : [0x01, tensionc_hi, tensionc_lo] -> battery (V)
//
// Multi-position shape (`channels[]`, see AUTHORING.md "Multi-channel devices").
// Every terminal the MR frames report is a sub-sensor position, so each position
// gets its own entry in the one reserved `channels` array — no suffixed extras:
//   digital input bit i -> { channel: 'input<i>', action: { contactState } }
//                          ("closed" when the bit is 1, else "open")
//   meter position n    -> { channel: 'meter<n>', pulse: { total } }
//                          (cumulative pulse index)
// Label scheme: the vendor's own term for the bank plus a zero-based position
// index. The counter bank is `meter0`..`meterN` because ATIM brands these units
// "MR" (meter reading) and their counter terminals metering inputs, where the
// sibling ACW-DINDxx family — marketed as generic digital/pulse monitoring —
// labels the same bank `counter0`..`counter7`; the dry-contact bank keeps that
// family's `input0`..`input15`. ATIM's frame names are 1-based ("compteur 1 et
// 2") while its N-counter frame 0x5E is 0-based (ancien_compteur0…), so the
// labels are normalized to 0-based physical positions: upstream compteur1 ->
// meter0, compteur3 -> meter2, ancien_compteur0 -> meter0. Entry order follows
// the payload (input bits first, then meter indices). A frame carrying both
// banks (0x52/0x4F/0x5E) puts both kinds of entry in the same array; labels are
// unique, so the two banks never collide.
//
// Whole-device readings stay top-level and are never repeated inside an entry:
// `battery` (life frame), the `frameType` extra, and the standard-meter frame's
// `wireCut` cable-cut status. `channels` is built lazily and omitted when a frame
// carries no positions at all (the life frame).
//
// Known limitation (fidelity, carried over unchanged from the suffixed-extra
// shape this replaced): the legacy ATIM input frame always carries 16 input bits
// regardless of how many contacts the variant physically exposes, and the payload
// has no variant or input-count field — so one `input<i>` entry is emitted per
// bit the frame carries rather than per terminal the product has, and positions
// above the variant's real count simply read "open". For the same reason the
// counter-pair frame 0x51 (compteur 3 et 4 -> meter2/meter3) is still decoded
// when it arrives, even though the MR2-EX itself exposes only meter0/meter1 — the
// frame set is shared across the legacy range. Do not infer a per-variant
// position count from these frames.
//
// Sentinel policy: none exists, and none is invented here. These frames define no
// per-position "disconnected"/fault encoding — an unwired contact reads "open"
// and an unconfigured meter index reads 0, both indistinguishable from real
// values — so no position is ever skipped: every position the frame carries gets
// an entry.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32be(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function inputBits(lo, hi) {
  var bits = [];
  var i;
  for (i = 0; i < 8; i++) {
    bits.push((lo >> i) & 1 ? 1 : 0);
  }
  for (i = 0; i < 8; i++) {
    bits.push((hi >> i) & 1 ? 1 : 0);
  }
  return bits;
}

// One channels entry per digital input bit: input0..input15.
function addInputs(channels, bits) {
  var i;
  for (i = 0; i < bits.length; i++) {
    channels.push({
      channel: 'input' + i,
      action: { contactState: bits[i] ? 'closed' : 'open' }
    });
  }
}

// One channels entry per cumulative meter index: meter<first>..meter<first+n-1>.
function addMeters(channels, totals, first) {
  var i;
  for (i = 0; i < totals.length; i++) {
    channels.push({
      channel: 'meter' + (first + i),
      pulse: { total: totals[i] }
    });
  }
}

// Attach the lazily-built channels array (omitted when the frame carries no
// positions) and return the success result.
function withChannels(data, channels) {
  if (channels.length > 0) {
    data.channels = channels;
  }
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var ft = bytes[0];
  var data = {};
  var channels = [];
  var totals;
  var i;

  if (ft === 0x01) {
    if (bytes.length < 3) {
      return { errors: ['life frame too short for battery voltage'] };
    }
    return { data: { battery: round(u16be(bytes[1], bytes[2]) / 1000, 3), frameType: 'life' } };
  }

  // Counter pairs: 0x50 carries compteur 1 & 2 (positions 0-1), 0x51 carries
  // compteur 3 & 4 (positions 2-3).
  if (ft === 0x50 || ft === 0x51) {
    if (bytes.length < 9) {
      return { errors: ['counter-pair frame too short'] };
    }
    addMeters(channels, [u32be(bytes, 1), u32be(bytes, 5)], ft === 0x50 ? 0 : 2);
    data.frameType = 'counters';
    return withChannels(data, channels);
  }

  // Standard meter frame: leading wire-cut status byte, then two counters.
  if (ft === 0x14) {
    if (bytes.length < 10) {
      return { errors: ['standard meter frame too short'] };
    }
    data.wireCut = Boolean(bytes[1]);
    addMeters(channels, [u32be(bytes, 2), u32be(bytes, 6)], 0);
    data.frameType = 'meter';
    return withChannels(data, channels);
  }

  // Digital inputs (Boolean-mode channels).
  if (ft === 0x42) {
    if (bytes.length < 3) {
      return { errors: ['digital-inputs frame too short'] };
    }
    addInputs(channels, inputBits(bytes[1], bytes[2]));
    data.frameType = 'digitalInputs';
    return withChannels(data, channels);
  }

  // Inputs + counter 1.
  if (ft === 0x52) {
    if (bytes.length < 7) {
      return { errors: ['inputs+counter frame too short'] };
    }
    addInputs(channels, inputBits(bytes[1], bytes[2]));
    addMeters(channels, [u32be(bytes, 3)], 0);
    data.frameType = 'inputsCounters';
    return withChannels(data, channels);
  }

  // Inputs + counters 1 & 2.
  if (ft === 0x4f) {
    if (bytes.length < 11) {
      return { errors: ['inputs+counters frame too short'] };
    }
    addInputs(channels, inputBits(bytes[1], bytes[2]));
    addMeters(channels, [u32be(bytes, 3), u32be(bytes, 7)], 0);
    data.frameType = 'inputsCounters';
    return withChannels(data, channels);
  }

  // Inputs + N counters (upstream ancien_compteur0..N-1: already 0-based).
  if (ft === 0x5e) {
    if (bytes.length < 7 || (bytes.length - 3) % 4 !== 0) {
      return { errors: ['inputs+counters frame malformed'] };
    }
    addInputs(channels, inputBits(bytes[1], bytes[2]));
    totals = [];
    for (i = 3; i + 3 < bytes.length; i += 4) {
      totals.push(u32be(bytes, i));
    }
    addMeters(channels, totals, 0);
    data.frameType = 'inputsCounters';
    return withChannels(data, channels);
  }

  return {
    errors: ['unsupported ATIM frame type 0x' + ft.toString(16) +
      ' (this codec decodes only MR2-EX metering/input/life frames)']
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "atim", model: "acw-mr2-ex" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "acw-mr2-ex";
  }
  return result;
}
