// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-DIND88 (Digital Monitoring: up to 8 dry
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
// order, yielding entree[0]=input0). Mapping into the vocabulary:
//   input 0 (dry contact)     -> action.contactState ("closed" if 1 else "open")
//   inputs 1..15              -> input2..input16 (boolean camelCase extras)
//   counter channel 1         -> pulse.count (cumulative meter index)
//   further counters          -> count2, count3, ... (number camelCase extras)
// contactState + pulse.count together satisfy the analog-interface membership.

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

// Attach input 0 as action.contactState and inputs 1..15 as extras.
function applyInputs(data, bits) {
  data.action = { contactState: bits[0] ? 'closed' : 'open' };
  var i;
  for (i = 1; i < bits.length; i++) {
    data['input' + (i + 1)] = Boolean(bits[i]);
  }
}

// Attach a list of counter values: first -> pulse.count, rest -> count2..countN.
function applyCounters(data, counts) {
  if (counts.length === 0) {
    return;
  }
  if (!data.pulse) {
    data.pulse = {};
  }
  data.pulse.count = counts[0];
  var i;
  for (i = 1; i < counts.length; i++) {
    data['count' + (i + 1)] = counts[i];
  }
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var ft = bytes[0];
  var data = {};
  var counts;
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
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    data.frameType = 'digitalInputs';
    return { data: data };
  }

  // Counter pairs (no inputs).
  if (ft === 0x50 || ft === 0x51 || ft === 0x5f || ft === 0x60) {
    if (bytes.length < 9) {
      return { errors: ['counter-pair frame too short'] };
    }
    applyCounters(data, [u32be(bytes, 1), u32be(bytes, 5)]);
    data.frameType = 'counters';
    return { data: data };
  }

  // Inputs + counter 1.
  if (ft === 0x52) {
    if (bytes.length < 7) {
      return { errors: ['inputs+counter frame too short'] };
    }
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    applyCounters(data, [u32be(bytes, 3)]);
    data.frameType = 'inputsCounters';
    return { data: data };
  }

  // Inputs + counters 1 & 2.
  if (ft === 0x4f) {
    if (bytes.length < 11) {
      return { errors: ['inputs+counters frame too short'] };
    }
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    applyCounters(data, [u32be(bytes, 3), u32be(bytes, 7)]);
    data.frameType = 'inputsCounters';
    return { data: data };
  }

  // Inputs + N counters.
  if (ft === 0x5e) {
    if (bytes.length < 7 || (bytes.length - 3) % 4 !== 0) {
      return { errors: ['inputs+counters frame malformed'] };
    }
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    counts = [];
    for (i = 3; i + 3 < bytes.length; i += 4) {
      counts.push(u32be(bytes, i));
    }
    applyCounters(data, counts);
    data.frameType = 'inputsCounters';
    return { data: data };
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
    result.data.model = "acw-dind88";
  }
  return result;
}
