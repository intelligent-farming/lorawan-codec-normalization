// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Ewattch TyNode -- a multi-input node offered in
// temperature, pulse-counting and analog (4-20 mA / 0-10 V / 0-24 V) variants.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream BSD-3-Clause decoder
// (TheThingsNetwork/lorawan-devices vendor/ewattch/EwattchLorawanDecoder.js,
// attributed in NOTICE). Upstream emits an array of per-channel objects with
// vendor-specific uuids; this module normalizes the primary analog / pulse /
// digital input to the shared vocabulary and does NOT copy upstream.
//
// Frame layout (measurement frames): byte0 = header select (0 => node-info
// mode, else measurement mode), byte1 = declared payload size (= length - 2).
// After the two header bytes comes a stream of TLV objects. Each object begins
// with a tag byte: bit0 = "has socket/channel", bit7 = error, bits1..6 select
// the object type as (tag & 0x7E). If bit0 is set, the next byte packs
// socket (bits5..7) and channel (bits0..4). Then the type-specific value bytes
// follow.
//
// Object types normalized here (first matching object wins):
//   0x28 analog input (3 value bytes): scale byte high bits pick resolution
//        (0.01 or 0.001); low 5 bits pick range/unit (0 = 4-20 mA, 1 = 0-10 V,
//        2 = 0-24 V). value = signed16(v1 | v2<<8) * resolution
//        -> analog.current (mA) or analog.voltage (V)
//   0x0C counter (2 value bytes)   -> pulse.count (u16)
//   0x20 digital input (1 value byte, low bit) -> action.contactState
//        (1 -> "closed", 0 -> "open")
// Other object types (temperature, energy clamps, TIC, modbus, ...) are not
// part of this analog-interface normalization and yield an error if no
// analog/pulse/digital object is present.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(v) {
  return (v & 0x8000) ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short for a TyNode measurement frame'] };
  }

  // Header: byte1 declares payload size (length - 2). Only measurement-mode
  // frames (byte0 != 0) carry input measurements.
  if (bytes[0] === 0) {
    return { errors: ['node-info frame carries no input measurement'] };
  }
  if (bytes[1] !== bytes.length - 2) {
    return { errors: ['declared payload size ' + bytes[1] + ' does not match length ' + bytes.length] };
  }

  var i = 2;
  var data = {};
  var found = false;

  while (i < bytes.length && !found) {
    var tag = bytes[i];
    var type = tag & 0x7e;
    var isError = (tag & 0x80) !== 0;
    var hasAddr = (tag & 0x01) !== 0;
    i += 1;
    if (hasAddr) {
      i += 1; // skip socket/channel byte
    }
    if (isError) {
      // error object carries a single trailing byte; skip it.
      i += 1;
      continue;
    }

    if (type === 0x28) {
      // Analog input: 3 value bytes.
      if (i + 3 > bytes.length) {
        return { errors: ['truncated analog-input object'] };
      }
      var scale = bytes[i];
      var raw = signed16((bytes[i + 1] | (bytes[i + 2] << 8)) & 0xffff);
      var res = ((scale & 0xe0) >> 5) ? 0.001 : 0.01;
      var rangeSel = scale & 0x1f;
      var value = round(raw * res, 3);
      if (rangeSel === 0) {
        data.analog = { current: value };
      } else {
        data.analog = { voltage: value };
      }
      found = true;
      i += 3;
    } else if (type === 0x0c) {
      // Counter: 2 value bytes.
      if (i + 2 > bytes.length) {
        return { errors: ['truncated counter object'] };
      }
      data.pulse = { count: (bytes[i] | (bytes[i + 1] << 8)) & 0xffff };
      found = true;
      i += 2;
    } else if (type === 0x20) {
      // Digital input: 1 value byte, low bit is the state.
      if (i + 1 > bytes.length) {
        return { errors: ['truncated digital-input object'] };
      }
      data.action = { contactState: (bytes[i] & 0x01) ? 'closed' : 'open' };
      found = true;
      i += 1;
    } else {
      // Unhandled object type: cannot know its length safely; stop scanning.
      break;
    }
  }

  if (!found) {
    return { errors: ['no analog/pulse/digital input object found in frame'] };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "ewattch";
    result.data.model = "tynode";
  }
  return result;
}
