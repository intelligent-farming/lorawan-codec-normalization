// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-DIND21 (Digital Monitoring: up to 8 dry
// contacts / pulse-counter indices). Category: analog-interface.
//
// Ported/normalized from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The DINDxx emits the legacy "ancien produit" digital-monitoring
// frames, dispatched upstream by frame_type_ancien() and shaped by
// decode_trame_ancien() + postProcessEntrerAncien()/postProcessAncienCompteur0_15().
// We author the normalization here; upstream normalizeUplink/postProcess output
// is never reused.
//
// Wire format (byte[0] = frame type):
//   0x42 digital inputs        : [0x42, in_lo, in_hi]  (16 input bits)
//   0x50 counters 1 & 2        : [0x50, c1(4), c2(4)]
//   0x51 counters 3 & 4        : [0x51, c3(4), c4(4)]
//   0x5F counters 5 & 6        : [0x5F, c5(4), c6(4)]
//   0x60 counters 7 & 8        : [0x60, c7(4), c8(4)]
//   0x52 inputs + counter 1    : [0x52, in_lo, in_hi, c1(4)]
//   0x4F inputs + counters 1,2 : [0x4F, in_lo, in_hi, c1(4), c2(4)]
//   0x5E inputs + N counters   : [0x5E, in_lo, in_hi, c0(4), c1(4), ...]
//   0x01 life frame            : [0x01, tensionc_hi, tensionc_lo] -> battery (V)
//
// Input bits: byte1 carries inputs 0-7 (LSB = input 0), byte2 inputs 8-15
// (upstream postProcessEntrerAncien reverses each nibble/byte to MSB-first
// order, yielding entree[0] = input 0).
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). This product reports two independent banks of sub-sensor
// positions - dry-contact digital inputs and pulse counters - and both ride in
// the one reserved `channels` array. They are different physical things, so
// they are separate entries rather than a merged position: entry labels only
// have to be unique within the array, and a single array keeps every position
// addressable in one flattener pass. Labels use the vendor's own term plus a
// zero-based index:
//   input bank   -> `input0` ... `input15`, each carrying action.contactState
//                   ("closed" when the bit is set, else "open"). Matches
//                   upstream's entree[] ordering, where entree[0] = input 0.
//   counter bank -> `counter0` ... `counter7`, each carrying pulse.count (the
//                   cumulative meter index). `counter0` is the vendor's
//                   "compteur 1" - upstream numbers the variable-length 0x5E
//                   frame's counters from 0 and the fixed pair frames from 1;
//                   the labels here are uniformly zero-based.
// Counter labels follow the frame's own counter base, so the index identifies
// the physical counter rather than its slot in this frame: 0x50 ->
// counter0/counter1, 0x51 -> counter2/counter3, 0x5F -> counter4/counter5,
// 0x60 -> counter6/counter7; 0x52/0x4F/0x5E start at counter0. (The previous
// flat shape mapped every counter frame onto pulse.count/count2 and so
// conflated counters 3-8 with counters 1-2.)
//
// Whole-device readings stay top-level and are never duplicated inside an
// entry: `battery` (life frame) and the `frameType` extra.
//
// Sentinel policy: there is no sentinel to honor. These frames carry no
// per-input "disconnected"/fault encoding - every one of the 16 input bits is
// a valid open/closed state - and a counter word is a plain unsigned 32-bit
// index with no reserved value. No position is therefore ever skipped for
// reading as unwired. An uplink carries input entries (0x42), counter entries
// (0x50/0x51/0x5F/0x60), or both (0x52/0x4F/0x5E) depending on frame type, so
// `channels` is built lazily and omitted entirely when a frame carries neither
// bank (the life frame).
//
// Known limitation - shared-frame width: the legacy ATIM frames are common to
// the whole DINDxx line and are fixed-width per frame type. 0x42 always
// carries 16 input bits and the counter frames up to 8 counters, whichever
// variant is talking, and the payload carries neither a population mask nor a
// model id. A 2-input DIND21 therefore still reports all 16 bits, with the
// unwired ones reading permanently "open", and this codec emits an entry for
// every bit/counter the frame carries. That is deliberate: a per-variant input
// count cannot be derived from the payload, and guessing one would silently
// drop real states on the wide models.

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

// Unpack 16 input bits from two bytes (LSB-first within each byte).
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

// Append one channels entry per digital input: action.contactState scoped to
// `input<n>`. Every bit the frame carries gets an entry (no fault sentinel
// exists to skip on).
function applyInputs(channels, bits) {
  var i;
  for (i = 0; i < bits.length; i++) {
    channels.push({
      channel: 'input' + i,
      action: { contactState: bits[i] ? 'closed' : 'open' }
    });
  }
}

// Append one channels entry per pulse counter: pulse.count scoped to
// `counter<base + n>`, base being the frame's first physical counter index.
function applyCounters(channels, counts, base) {
  var i;
  for (i = 0; i < counts.length; i++) {
    channels.push({
      channel: 'counter' + (base + i),
      pulse: { count: counts[i] }
    });
  }
}

// Assemble the measurement, attaching `channels` only when this frame carried
// sub-sensor positions.
function measurement(channels, frameType) {
  var data = {};
  if (channels.length > 0) {
    data.channels = channels;
  }
  data.frameType = frameType;
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var ft = bytes[0];
  var channels = [];
  var counts;
  var base;
  var i;

  if (ft === 0x01) {
    if (bytes.length < 3) {
      return { errors: ['life frame too short for battery voltage'] };
    }
    return { data: { battery: round(u16be(bytes[1], bytes[2]) / 1000, 3), frameType: 'life' } };
  }

  // Digital inputs only.
  if (ft === 0x42) {
    if (bytes.length < 3) {
      return { errors: ['digital-inputs frame too short'] };
    }
    applyInputs(channels, inputBits(bytes[1], bytes[2]));
    return measurement(channels, 'digitalInputs');
  }

  // Counter pairs (no inputs). The frame type names the pair it carries, so the
  // labels start at that pair's base index.
  if (ft === 0x50 || ft === 0x51 || ft === 0x5f || ft === 0x60) {
    if (bytes.length < 9) {
      return { errors: ['counter-pair frame too short'] };
    }
    base = 0;
    if (ft === 0x51) {
      base = 2;
    } else if (ft === 0x5f) {
      base = 4;
    } else if (ft === 0x60) {
      base = 6;
    }
    applyCounters(channels, [u32be(bytes, 1), u32be(bytes, 5)], base);
    return measurement(channels, 'counters');
  }

  // Inputs + counter 1.
  if (ft === 0x52) {
    if (bytes.length < 7) {
      return { errors: ['inputs+counter frame too short'] };
    }
    applyInputs(channels, inputBits(bytes[1], bytes[2]));
    applyCounters(channels, [u32be(bytes, 3)], 0);
    return measurement(channels, 'inputsCounters');
  }

  // Inputs + counters 1 & 2.
  if (ft === 0x4f) {
    if (bytes.length < 11) {
      return { errors: ['inputs+counters frame too short'] };
    }
    applyInputs(channels, inputBits(bytes[1], bytes[2]));
    applyCounters(channels, [u32be(bytes, 3), u32be(bytes, 7)], 0);
    return measurement(channels, 'inputsCounters');
  }

  // Inputs + N counters.
  if (ft === 0x5e) {
    if (bytes.length < 7 || (bytes.length - 3) % 4 !== 0) {
      return { errors: ['inputs+counters frame malformed'] };
    }
    applyInputs(channels, inputBits(bytes[1], bytes[2]));
    counts = [];
    for (i = 3; i + 3 < bytes.length; i += 4) {
      counts.push(u32be(bytes, i));
    }
    applyCounters(channels, counts, 0);
    return measurement(channels, 'inputsCounters');
  }

  return {
    errors: ['unsupported ATIM frame type 0x' + ft.toString(16) +
      ' (this codec decodes only DINDxx digital/counter/life frames)']
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "acw-dind21";
  }
  return result;
}
