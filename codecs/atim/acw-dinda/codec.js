// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-DINDA (Analog Monitoring: a single
// 4-20 mA or 0-10 V analog input, plus two digital status inputs).
// Category: analog-interface.
//
// Ported/normalized from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The DINDA emits the legacy "ancien produit" DINDA frames, dispatched
// upstream by frame_type_ancien() and shaped by decode_trame_ancien() +
// postProcessAncienDINDA(). We author the normalization here; upstream
// normalizeUplink/postProcess output is never reused.
//
// Wire format (byte[0] = frame type):
//   0x18 periodic 0-10 V reading : [0x18, logicLevel, volt_hi, volt_lo]
//        upstream voltage = (hi<<8|lo) * 10 / 64240  V   -> analog.voltage (V)
//   0x19 periodic 0-20 mA reading: [0x19, logicLevel, cur_hi, cur_lo]
//        upstream current = (hi<<8|lo) * 20 / 47584  mA  -> analog.current (mA)
//   0x1e/0x1f/0x20 0-10 V alert frames  : same [type, logicLevel, volt_hi, volt_lo]
//   0x22/0x23/0x24 4-20 mA alert frames : [type, logicLevel, cur_hi, cur_lo, offset]
//        upstream current = (hi<<8|lo) * 16 / 47584  mA  (4-20 mA span, has offset)
//   0x01 life frame              : [0x01, tensionc_hi, tensionc_lo] -> battery (V)
//
// logicLevel byte: bit5 -> first digital input, bit4 -> second digital input
// (upstream postProcessAncienDINDA reads MSB-first string indices [2] and [3],
// yielding logic_level[0] and logic_level[1]).
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). The two digital status inputs are two sub-sensor positions of the
// same physical kind, so each becomes an entry in the reserved `channels`
// array, labelled with the vendor's own term plus a zero-based index -
// `input0` (bit5) and `input1` (bit4) - matching upstream's logic_level[]
// ordering. Each entry carries action.contactState ("closed" when the bit is
// set, else "open"), so this device speaks the same key as its five DINDxx
// siblings instead of the previous boolean extras input1/input2. That renames
// the positions by one (old input1/input2 -> input0/input1) and adds
// action.contactState to `provides`; the analog-interface membership is
// unaffected, since the category has no `requires` and lists both analog.* and
// action.contactState among its `atLeastOne` paths (and the analog reading
// stays top-level regardless).
//
// The analog input is a single position, not a bank, so its reading stays
// top-level as analog.voltage / analog.current - there is nothing to scope it
// against, and a lone entry would only add indirection. `frameType` (extra) and
// `battery` (life frame) are likewise whole-device and stay top-level. No leaf
// is emitted both places.
//
// Sentinel policy: none exists to honor. The logicLevel byte has no
// "disconnected"/fault encoding - each bit is a valid open/closed state - so no
// position is ever skipped, and every analog/alert frame carries the byte.
// `channels` is built only for frames that carry it and is omitted from the
// life frame, which reports no positions. (Out-of-range analog readings are
// signalled by the vendor with dedicated alert frame types, not by a sentinel
// value.)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// logicLevel -> one channels entry per digital input. Upstream reads MSB-first
// string index [2] (bit5) as the first input and [3] (bit4) as the second.
function logicInputs(b) {
  return [
    { channel: 'input0', action: { contactState: (b & 0x20) ? 'closed' : 'open' } },
    { channel: 'input1', action: { contactState: (b & 0x10) ? 'closed' : 'open' } }
  ];
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var ft = bytes[0];

  // Life frame: secondary supply-rail voltage -> battery.
  if (ft === 0x01) {
    if (bytes.length < 3) {
      return { errors: ['life frame too short for battery voltage'] };
    }
    return { data: { battery: round(u16be(bytes[1], bytes[2]) / 1000, 3), frameType: 'life' } };
  }

  // 0-10 V frames (periodic 0x18, alerts 0x1e/0x1f/0x20).
  if (ft === 0x18 || ft === 0x1e || ft === 0x1f || ft === 0x20) {
    if (bytes.length < 4) {
      return { errors: ['0-10V frame too short'] };
    }
    var volts = round(u16be(bytes[2], bytes[3]) * 10 / 64240, 2);
    return { data: { analog: { voltage: volts }, channels: logicInputs(bytes[1]), frameType: 'voltage' } };
  }

  // 0-20 mA periodic (0x19): full-scale span 20 mA, no offset byte.
  if (ft === 0x19) {
    if (bytes.length < 4) {
      return { errors: ['0-20mA frame too short'] };
    }
    var mA = round(u16be(bytes[2], bytes[3]) * 20 / 47584, 2);
    return { data: { analog: { current: mA }, channels: logicInputs(bytes[1]), frameType: 'current' } };
  }

  // 4-20 mA alert frames (0x22/0x23/0x24): span 16 mA, trailing offset byte.
  if (ft === 0x22 || ft === 0x23 || ft === 0x24) {
    if (bytes.length < 4) {
      return { errors: ['4-20mA frame too short'] };
    }
    var mA2 = round(u16be(bytes[2], bytes[3]) * 16 / 47584, 2);
    return { data: { analog: { current: mA2 }, channels: logicInputs(bytes[1]), frameType: 'current' } };
  }

  return {
    errors: ['unsupported ATIM frame type 0x' + ft.toString(16) +
      ' (this codec decodes only DINDA analog/life frames)']
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "acw-dinda";
  }
  return result;
}
