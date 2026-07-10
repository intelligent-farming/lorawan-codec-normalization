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
// Metering indices are cumulative -> pulse.total (channel 1) with further
// channels as total2, total3, ... (number camelCase extras). A channel run in
// Boolean mode reports via the digital-input frame: input 0 -> action.contactState
// ("closed"/"open"), inputs 1..15 -> input2..input16 (boolean extras). Either a
// counter frame (pulse.total) or an input frame (action.contactState) satisfies
// the analog-interface membership.

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

function applyInputs(data, bits) {
  data.action = { contactState: bits[0] ? 'closed' : 'open' };
  var i;
  for (i = 1; i < bits.length; i++) {
    data['input' + (i + 1)] = Boolean(bits[i]);
  }
}

// Cumulative meter indices: first -> pulse.total, rest -> total2..totalN.
function applyTotals(data, totals) {
  if (totals.length === 0) {
    return;
  }
  if (!data.pulse) {
    data.pulse = {};
  }
  data.pulse.total = totals[0];
  var i;
  for (i = 1; i < totals.length; i++) {
    data['total' + (i + 1)] = totals[i];
  }
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var ft = bytes[0];
  var data = {};
  var totals;
  var i;

  if (ft === 0x01) {
    if (bytes.length < 3) {
      return { errors: ['life frame too short for battery voltage'] };
    }
    return { data: { battery: round(u16be(bytes[1], bytes[2]) / 1000, 3), frameType: 'life' } };
  }

  // Counter pairs.
  if (ft === 0x50 || ft === 0x51) {
    if (bytes.length < 9) {
      return { errors: ['counter-pair frame too short'] };
    }
    applyTotals(data, [u32be(bytes, 1), u32be(bytes, 5)]);
    data.frameType = 'counters';
    return { data: data };
  }

  // Standard meter frame: leading wire-cut status byte, then two counters.
  if (ft === 0x14) {
    if (bytes.length < 10) {
      return { errors: ['standard meter frame too short'] };
    }
    data.wireCut = Boolean(bytes[1]);
    applyTotals(data, [u32be(bytes, 2), u32be(bytes, 6)]);
    data.frameType = 'meter';
    return { data: data };
  }

  // Digital inputs (Boolean-mode channels).
  if (ft === 0x42) {
    if (bytes.length < 3) {
      return { errors: ['digital-inputs frame too short'] };
    }
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    data.frameType = 'digitalInputs';
    return { data: data };
  }

  // Inputs + counter 1.
  if (ft === 0x52) {
    if (bytes.length < 7) {
      return { errors: ['inputs+counter frame too short'] };
    }
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    applyTotals(data, [u32be(bytes, 3)]);
    data.frameType = 'inputsCounters';
    return { data: data };
  }

  // Inputs + counters 1 & 2.
  if (ft === 0x4f) {
    if (bytes.length < 11) {
      return { errors: ['inputs+counters frame too short'] };
    }
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    applyTotals(data, [u32be(bytes, 3), u32be(bytes, 7)]);
    data.frameType = 'inputsCounters';
    return { data: data };
  }

  // Inputs + N counters.
  if (ft === 0x5e) {
    if (bytes.length < 7 || (bytes.length - 3) % 4 !== 0) {
      return { errors: ['inputs+counters frame malformed'] };
    }
    applyInputs(data, inputBits(bytes[1], bytes[2]));
    totals = [];
    for (i = 3; i + 3 < bytes.length; i += 4) {
      totals.push(u32be(bytes, i));
    }
    applyTotals(data, totals);
    data.frameType = 'inputsCounters';
    return { data: data };
  }

  return {
    errors: ['unsupported ATIM frame type 0x' + ft.toString(16) +
      ' (this codec decodes only MR2-EX metering/input/life frames)']
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "acw-mr2-ex";
  }
  return result;
}
