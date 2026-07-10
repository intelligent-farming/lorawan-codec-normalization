// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lt22222-l (LT-22222-L LoRaWAN I/O
// Controller: 2 analog voltage inputs (AVI, 0-30 V), 2 analog current inputs
// (ACI, 0-20 mA), 2 digital inputs (DI), 2 digital outputs (DO) and 2 relay
// outputs (RO); the input mix depends on the configured work mode).
// Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lt22222-l.js, attributed in
// NOTICE). Upstream emits a flat bag of string-valued fields (AVI1_V, ACI1_mA,
// DI1_status 'H'/'L', DO/RO 'ON'/'OFF', Count*_times); this module authors the
// normalized vocabulary and keeps the rest as camelCase extras. Upstream
// normalization is never copied.
//
// fPort 2 telemetry (11-byte frame). byte[10]: bits 6-7 = hardware id, bits 0-5
// = work mode. byte[8] = digital I/O status bitfield. The analog channels are
// signed 16-bit big-endian, value / 1000 (AVI -> V, ACI -> mA). Work modes:
//   mode 1  2ACI+2AVI          : AVI1/2 (V), ACI1/2 (mA), DI1/DI2
//   mode 2  Count mode 1       : Count1, Count2
//   mode 3  2ACI+1Count        : ACI1/2 (mA), Count1
//   mode 4  Count mode 2       : Acount
//   mode 5  1ACI+2AVI+1Count   : AVI1/2 (V), ACI1 (mA), Count1 (16-bit)
//   mode 6  Exit/alarm mode    : flag/status bits only (no fresh measurement)
//
// Channel-1 vocabulary mapping (others -> camelCase extras):
//   AVI1  -> analog.voltage (V)      DI1 -> action.contactState ('H'=closed)
//   ACI1  -> analog.current (mA)     Count1 -> pulse.count
//   AVI2/ACI2 -> voltage2/current2   DI2/DI3 -> input2/input3
//   DO1-3/RO1-2 -> do1..do3/ro1..ro2 (booleans)  Count2/Acount -> count2/acount
// fPort 5 (device status) carries no interface measurement -> error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// signed 16-bit big-endian
function s16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  return v & 0x8000 ? v - 0x10000 : v;
}

function u32be(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function decodeUplinkCore(input) {
  var b = input.bytes;

  if (input.fPort === 5) {
    return { errors: ['device-status frame (fPort 5) carries no interface measurement'] };
  }
  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (!b || b.length !== 11) {
    return { errors: ['expected 11-byte telemetry frame, got ' + (b ? b.length : 0)] };
  }

  var hardware = (b[10] & 0xc0) >> 6;
  var mode = b[10] & 0x3f;
  var data = {};

  data.hardwareMode = hardware === 0 ? 'LT33222' : 'LT22222';
  data.workMode = mode;

  // Digital outputs / relays (present except in exit mode).
  if (mode !== 6) {
    data.do1 = !(b[8] & 0x01);
    data.do2 = !(b[8] & 0x02);
    data.ro1 = Boolean(b[8] & 0x80);
    data.ro2 = Boolean(b[8] & 0x40);
    if (hardware === 0) {
      data.do3 = !(b[8] & 0x04);
    }
  }

  if (mode === 1) {
    // 2ACI+2AVI: full analog + digital-input set.
    data.analog = {
      voltage: round(s16(b[0], b[1]) / 1000, 3),
      current: round(s16(b[4], b[5]) / 1000, 3)
    };
    data.voltage2 = round(s16(b[2], b[3]) / 1000, 3);
    data.current2 = round(s16(b[6], b[7]) / 1000, 3);
    data.action = { contactState: (b[8] & 0x08) ? 'closed' : 'open' };
    data.input2 = Boolean(b[8] & 0x10);
    if (hardware === 0) {
      data.input3 = Boolean(b[8] & 0x20);
    }
    return { data: data };
  }

  if (mode === 2) {
    // Count mode 1: two 32-bit counters.
    data.pulse = { count: u32be(b, 0) };
    data.count2 = u32be(b, 4);
    return { data: data };
  }

  if (mode === 3) {
    // 2ACI+1Count: current channel(s) + cumulative counter.
    data.analog = { current: round(s16(b[4], b[5]) / 1000, 3) };
    data.current2 = round(s16(b[6], b[7]) / 1000, 3);
    data.pulse = { count: u32be(b, 0) };
    return { data: data };
  }

  if (mode === 4) {
    // Count mode 2: single 32-bit counter (bytes 4-7).
    data.pulse = { count: u32be(b, 4) };
    return { data: data };
  }

  if (mode === 5) {
    // 1ACI+2AVI+1Count.
    data.analog = {
      voltage: round(s16(b[0], b[1]) / 1000, 3),
      current: round(s16(b[4], b[5]) / 1000, 3)
    };
    data.voltage2 = round(s16(b[2], b[3]) / 1000, 3);
    data.pulse = { count: ((b[6] << 8) | b[7]) & 0xffff };
    return { data: data };
  }

  // mode 6 (exit/alarm) and any other mode carry only flag/status bits, no fresh
  // interface reading to normalize.
  return { errors: ['work mode ' + mode + ' carries no normalizable interface reading'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lt22222-l";
  }
  return result;
}
