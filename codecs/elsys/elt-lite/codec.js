// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elsys/elt-lite (ELSYS ELT Lite: a LoRaWAN sensor
// hub that provides power to and measures external analog or digital signals).
// Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 ELSYS decoder
// (TheThingsNetwork/lorawan-devices vendor/elsys/elsys.js, attributed in NOTICE).
// The ELSYS payload is a self-describing TLV stream: each field starts with a
// one-byte type, followed by a fixed number of value bytes. Upstream emits a raw
// bag (analog1 in mV, digital 0/1, vdd in mV, pulse counts); this module walks
// the same TLV grammar and authors normalized vocabulary keys. Upstream
// normalizeUplink is never copied.
//
// TLV types handled (from the ELSYS sensor payload spec):
//   0x01 TEMP        2 bytes  signed /10 degC  -> air.temperature
//   0x07 VDD         2 bytes  mV               -> battery (V; mV / 1000)
//   0x08 ANALOG1     2 bytes  mV               -> analog.voltage (V; mV / 1000)
//   0x18 ANALOG2     2 bytes  mV               -> voltage2 (V extra)
//   0x0A PULSE1      2 bytes  relative count   -> pulse.count
//   0x0B PULSE1_ABS  4 bytes  absolute count   -> pulse.total
//   0x0C EXT_TEMP1   2 bytes  signed /10 degC  -> externalTemperature (extra)
//   0x0D EXT_DIGITAL 1 byte   0/1              -> action.contactState (1=closed)
//   0x1A EXT_DIGITAL2 1 byte  0/1              -> input2 (boolean extra)
// Unhandled types have variable widths; encountering one stops the walk (the
// upstream decoder does the same), so we decode the leading interface fields and
// warn that the remainder was skipped.

var WIDTH = {
  1: 2, 7: 2, 8: 2, 10: 2, 11: 4, 12: 2, 13: 1, 24: 2, 26: 1
};

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(b, i) {
  return ((b[i + 1] << 8) | b[i + 2]) & 0xffff;
}

function s16(b, i) {
  var v = u16(b, i);
  return v & 0x8000 ? v - 0x10000 : v;
}

function u32(b, i) {
  return ((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]) >>> 0;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 1) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var warnings = [];
  var i = 0;

  while (i < b.length) {
    var type = b[i];
    var w = WIDTH[type];

    if (w === undefined) {
      warnings.push('stopped at unsupported ELSYS type 0x' + type.toString(16));
      break;
    }
    if (i + w >= b.length) {
      return { errors: ['truncated ELSYS field for type 0x' + type.toString(16)] };
    }

    if (type === 0x01) {
      data.air = data.air || {};
      data.air.temperature = round(s16(b, i) / 10, 1);
    } else if (type === 0x07) {
      data.battery = round(u16(b, i) / 1000, 3);
    } else if (type === 0x08) {
      data.analog = data.analog || {};
      data.analog.voltage = round(u16(b, i) / 1000, 3);
    } else if (type === 0x18) {
      data.voltage2 = round(u16(b, i) / 1000, 3);
    } else if (type === 0x0a) {
      data.pulse = data.pulse || {};
      data.pulse.count = u16(b, i);
    } else if (type === 0x0b) {
      data.pulse = data.pulse || {};
      data.pulse.total = u32(b, i);
    } else if (type === 0x0c) {
      data.externalTemperature = round(s16(b, i) / 10, 1);
    } else if (type === 0x0d) {
      data.action = data.action || {};
      data.action.contactState = b[i + 1] ? 'closed' : 'open';
    } else if (type === 0x1a) {
      data.input2 = Boolean(b[i + 1]);
    }

    i += 1 + w;
  }

  var hasKey = false;
  var k;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasKey = true;
      break;
    }
  }
  if (!hasKey) {
    return { errors: ['no decodable interface field in payload'] };
  }

  var out = { data: data };
  if (warnings.length) {
    out.warnings = warnings;
  }
  return out;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elsys";
    result.data.model = "elt-lite";
  }
  return result;
}
