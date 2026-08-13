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
//   0x01 TEMP        2 bytes  signed /10 degC  -> air.temperature   (top level)
//   0x07 VDD         2 bytes  mV               -> battery (V; mV / 1000)
//   0x08 ANALOG1     2 bytes  mV               -> port0 analog.voltage (mV/1000)
//   0x18 ANALOG2     2 bytes  mV               -> port1 analog.voltage (mV/1000)
//   0x0A PULSE1      2 bytes  relative count   -> pulse.count       (top level)
//   0x0B PULSE1_ABS  4 bytes  absolute count   -> pulse.total       (top level)
//   0x0C EXT_TEMP1   2 bytes  signed /10 degC  -> externalTemperature (extra,
//                                                 top level)
//   0x0D EXT_DIGITAL 1 byte   0/1              -> port0 action.contactState
//   0x1A EXT_DIGITAL2 1 byte  0/1              -> port1 action.contactState
// Unhandled types have variable widths; encountering one stops the walk (the
// upstream decoder does the same), so we decode the leading interface fields and
// warn that the remainder was skipped.
//
// External ports -> reserved `channels[]` (see AUTHORING.md "Multi-channel
// devices"). ELSYS carries the external-port index in the TLV type byte itself.
// This device's decoder covers TWO of the shared ELSYS external banks at BOTH
// positions, so those two are genuine two-position banks and become channel
// entries; the remaining banks are decoded at port 1 only and are left alone:
//     bank                    port 1 type   port 2 type
//     analog input               0x08          0x18     (both -> channels)
//     external digital input     0x0d          0x1a     (both -> channels)
//     pulse counter, relative    0x0a          --       (0x16 not decoded)
//     pulse counter, absolute    0x0b          --       (0x17 not decoded)
//     external temperature       0x0c          --       (0x19 not decoded)
// Entry labels use the vendor's own term plus a 0-based index: `port0` = ELSYS
// port 1 (types 0x08/0x0d), `port1` = ELSYS port 2 (types 0x18/0x1a). The port
// index therefore leaves the key name and lives only in the entry label, so both
// entries carry the *same* keys:
//     analog.voltage (0x08) / voltage2 (0x18)  -> entry `analog.voltage`
//     action.contactState (0x0d) / input2 (0x1a) -> entry `action.contactState`
// Both port-2 readings previously carried a suffixed extra name (`voltage2`,
// `input2`) that lost the bank's vocabulary key; they now use the same key the
// bank's port-1 reading already used, with identical scaling (mV / 1000 rounded
// to 3 for the analog bank, 1 -> 'closed' / 0 -> 'open' for the digital bank).
//
// IMPORTANT: ELSYS `voltage` here is NOT the device supply rail. VDD (0x07) is
// the supply and maps to the whole-device `battery`; 0x08/0x18 are the two
// externally-powered analog *inputs*, which is why they are a port pair and the
// battery is not part of it.
//
// Whole-device and port-1-only readings stay top-level: battery (VDD),
// air.temperature (onboard), and the pulse counter (`pulse.count`/`pulse.total`,
// 0x0a/0x0b) and probe temperature (`externalTemperature`, 0x0c) whose port-2
// TLVs this decoder does not handle, so there is no second position to scope
// them against. Nothing is emitted both places.
//
// Sentinel/absent-port policy: an ELSYS TLV stream is sparse -- a port's TLV is
// simply absent when nothing is attached to it (there is no disconnected
// sentinel value), so entries are built lazily on first sight. A port that
// reported no reading gets no entry, and `channels` is omitted entirely when
// neither port reported. Entry order follows the payload.

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

  // One `channels[]` entry per external port, created on first sight so entry
  // order follows the payload and an unused port produces no entry.
  var channels = [];
  var portSlot = {};

  function portFor(port) {
    var label = 'port' + port;
    if (portSlot[label] === undefined) {
      portSlot[label] = channels.length;
      channels.push({ channel: label });
    }
    return channels[portSlot[label]];
  }

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
      // ANALOG1: external port 1 analog input, mV -> analog.voltage in volts.
      var p0Analog = portFor(0);
      p0Analog.analog = p0Analog.analog || {};
      p0Analog.analog.voltage = round(u16(b, i) / 1000, 3);
    } else if (type === 0x18) {
      // ANALOG2: external port 2 analog input, same bank/key/scaling as port 1.
      var p1Analog = portFor(1);
      p1Analog.analog = p1Analog.analog || {};
      p1Analog.analog.voltage = round(u16(b, i) / 1000, 3);
    } else if (type === 0x0a) {
      data.pulse = data.pulse || {};
      data.pulse.count = u16(b, i);
    } else if (type === 0x0b) {
      data.pulse = data.pulse || {};
      data.pulse.total = u32(b, i);
    } else if (type === 0x0c) {
      data.externalTemperature = round(s16(b, i) / 10, 1);
    } else if (type === 0x0d) {
      // EXT_DIGITAL: external port 1 dry contact, 1 = closed.
      var p0Digital = portFor(0);
      p0Digital.action = p0Digital.action || {};
      p0Digital.action.contactState = b[i + 1] ? 'closed' : 'open';
    } else if (type === 0x1a) {
      // EXT_DIGITAL2: external port 2 dry contact, same bank/key/mapping.
      var p1Digital = portFor(1);
      p1Digital.action = p1Digital.action || {};
      p1Digital.action.contactState = b[i + 1] ? 'closed' : 'open';
    }

    i += 1 + w;
  }

  // Omit `channels` entirely when neither external port reported.
  if (channels.length > 0) {
    data.channels = channels;
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
