// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Fencyboy electric-fence monitor.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream decoder
// (TheThingsNetwork/lorawan-devices
// vendor/fencyboy/fencyboy-v1-3-1_payload_decoder_ttn.js, attributed in NOTICE;
// (C) Fencyboy GmbH). Upstream emits FENCEVOLTAGE/IMPULSES/BATTERYVOLTAGE/etc;
// this module normalizes those to the shared vocabulary and does NOT copy
// upstream.
//
// Normal payload (fPort 1). Fields are big-endian (MSB first):
//   byte0            = status (bit2 = battery-sensor data present)
//   bytes[1..2]      = battery voltage (mV) -> battery (V)   [u16]
//   bytes[3..4]      = impulse counter (fence pulses fired)  [u16]
//   If impulses > 0, a fence-voltage block follows:
//     bytes[5..6]    = fence voltage (V)                     [s16]
//     bytes[7..8]    = fence voltage std-dev (V/10)          [s16]
//     bytes[9..10]   = fence voltage min (V)                 [s16]
//     bytes[11..12]  = fence voltage max (V)                 [s16]
//   If battery-sensor data present, a battery block follows next:
//     [+0..1]        = battery voltage (mV) -> battery (V)   [s16, overrides]
//     [+2..5]        = remaining capacity (float32 BE, mAh)
//     [+6..7]        = temperature (degC/100)                [s16]
// Valid lengths: 5, 13 (baseline+one block) or 21 (baseline+both blocks).
//
// Normalization (the fence voltage is a genuine decoded analog reading and the
// impulse counter a genuine pulse count, so both map to the analog-interface
// vocabulary):
//   FENCEVOLTAGE     -> analog.voltage (V)
//   IMPULSES         -> pulse.count
//   BATTERYVOLTAGE   -> battery (V)
//   TEMPERATURE      -> air.temperature (degC)
// Fence std/min/max and remaining capacity are exposed as camelCase extras.
// fPort 2 (settings) and fPort 3 (restart timer) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, off) {
  return ((bytes[off] << 8) | bytes[off + 1]) & 0xffff;
}

function s16be(bytes, off) {
  var v = u16be(bytes, off);
  return v > 0x7fff ? v - 0x10000 : v;
}

// IEEE-754 single-precision, big-endian (MSB first).
function float32be(bytes, off) {
  var bits = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  var sign = (bits >>> 31) === 0 ? 1.0 : -1.0;
  var exp = (bits >>> 23) & 0xff;
  var mant = bits & 0x7fffff;
  if (exp === 0xff) {
    return mant === 0 ? sign * Infinity : NaN;
  }
  var m;
  var e;
  if (exp === 0) {
    e = -126;
    m = mant / 0x800000;
  } else {
    e = exp - 127;
    m = 1 + mant / 0x800000;
  }
  return sign * m * Math.pow(2, e);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (only the normal payload on fPort 1 is normalized)'] };
  }
  var len = bytes ? bytes.length : 0;
  if (len !== 5 && len !== 13 && len !== 21) {
    return { errors: ['unexpected normal-payload length ' + len + ' (expected 5, 13 or 21)'] };
  }

  var status = bytes[0];
  var hasBatterySensorData = (status & 0x04) !== 0;

  var idx = 1;
  var data = {};
  data.battery = round(u16be(bytes, idx) / 1000, 3);
  idx += 2;

  var impulses = u16be(bytes, idx);
  idx += 2;
  data.pulse = { count: impulses };
  data.activeMode = (status & 0x01) !== 0;

  if (impulses > 0) {
    data.analog = { voltage: s16be(bytes, idx) };
    idx += 2;
    data.fenceVoltageStd = round(s16be(bytes, idx) / 10, 1);
    idx += 2;
    data.fenceVoltageMin = s16be(bytes, idx);
    idx += 2;
    data.fenceVoltageMax = s16be(bytes, idx);
    idx += 2;
  } else {
    // No fence pulses this interval: fence voltage is zero by definition.
    data.analog = { voltage: 0 };
  }

  if (hasBatterySensorData) {
    data.battery = round(s16be(bytes, idx) / 1000, 3);
    idx += 2;
    data.remainingCapacityMah = float32be(bytes, idx);
    idx += 4;
    data.air = { temperature: round(s16be(bytes, idx) / 100, 2) };
    idx += 2;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "fencyboy", model: "fencyboy" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "fencyboy";
    result.data.model = "fencyboy";
  }
  return result;
}
