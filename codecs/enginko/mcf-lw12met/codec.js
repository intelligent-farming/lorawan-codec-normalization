// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LW12MET (LoRaWAN mono-phase
// energy meter with I/O). Enginko is the MCF88 rebrand; this device shares the
// upstream "mcf-power-codec" decoder with the rest of the MCF-LW12xx power
// family.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 metering frame id 0x09) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/mcf-power-codec.js, attributed in NOTICE) — specifically its
// parseMetering / parseDate / parseSignedInt / parseSignedShort /
// parseUnsignedShort helpers. We author the normalization here; the upstream
// string-slicing helpers and its locale-dependent parseDate (toLocaleString) are
// not reused, and we do not copy its TTNto normalizeUplink.
//
// Metering frame 0x09 layout (matches upstream parseMetering, all multi-byte
// fields little-endian):
//   id(1=0x09) date(4) activeEnergy(4 s32, Wh) reactiveEnergy(4 s32, VARh)
//   apparentEnergy(4 s32, VAh)
//   then EITHER a short variant (21-byte frame):
//     activation(4 u32, s)
//   OR a full variant (33-byte frame):
//     activePower(2 s16, W) reactivePower(2 s16, VAR) apparentPower(2 s16, VA)
//     voltage(2 u16, dV RMS) current(2 u16, mA RMS) period(2 u16, microseconds)
//     activation(4 u32, s)
// Upstream selects the variant on hex-string length (<=42 chars => short). We
// select on byte length (<=21 bytes => short) which is equivalent.
//
// Vocabulary mapping (power-meter category):
//   activeEnergy Wh   -> metering.energy.total (Wh, no conversion)
//   activePower  W    -> power.active (W)
//   voltage      dV   -> power.voltage (V) = dV / 10
//   current      mA   -> power.current (A) = mA / 1000
//   apparentPower VA  -> power.apparent (VA)
//   frequency    Hz   -> power.frequency (Hz), 1e6 / period_microseconds
// Reactive/apparent energy, reactive power, integration period and activation
// time are not in the vocabulary and are emitted as camelCase extras
// (reactiveEnergy, apparentEnergy, reactivePower, periodMicroseconds,
// activationSeconds). The frame timestamp is emitted as RFC3339 `time`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function s32le(b0, b1, b2, b3) {
  // (x << 0) coerces the unsigned 32-bit value back to a signed 32-bit int.
  return u32le(b0, b1, b2, b3) | 0;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// MCF88/Enginko packed timestamp: 4 LSB bytes -> 32-bit value, fields are
// year-2000(7) month(4) day(5) hour(5) minute(6) second/2(5), MSB-first within
// the assembled word. Returns an RFC3339 string (treated as UTC). Authored here
// in place of upstream parseDate, which formats via toLocaleString and is
// therefore locale/timezone-dependent.
function decodeTime(b0, b1, b2, b3) {
  var v = u32le(b0, b1, b2, b3);
  var year = ((v >>> 25) & 0x7f) + 2000;
  var month = (v >>> 21) & 0x0f;
  var day = (v >>> 16) & 0x1f;
  var hour = (v >>> 11) & 0x1f;
  var minute = (v >>> 5) & 0x3f;
  var second = (v & 0x1f) * 2;
  return (
    year +
    '-' +
    pad2(month) +
    '-' +
    pad2(day) +
    'T' +
    pad2(hour) +
    ':' +
    pad2(minute) +
    ':' +
    pad2(second) +
    'Z'
  );
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var id = bytes[0];
  if (id !== 0x09) {
    return { errors: ['unsupported frame id 0x' + id.toString(16)] };
  }

  // Both variants require at least the 17-byte header plus a 4-byte activation.
  if (bytes.length < 21) {
    return { errors: ['metering frame 0x09 too short: ' + bytes.length + ' bytes'] };
  }

  var data = {};
  data.time = decodeTime(bytes[1], bytes[2], bytes[3], bytes[4]);

  var activeEnergy = s32le(bytes[5], bytes[6], bytes[7], bytes[8]);
  var reactiveEnergy = s32le(bytes[9], bytes[10], bytes[11], bytes[12]);
  var apparentEnergy = s32le(bytes[13], bytes[14], bytes[15], bytes[16]);

  var metering = {};
  var energy = {};
  energy.total = activeEnergy;
  metering.energy = energy;
  data.metering = metering;

  data.reactiveEnergy = reactiveEnergy;
  data.apparentEnergy = apparentEnergy;

  if (bytes.length <= 21) {
    // Short variant: id(1) date(4) 3x energy(12) activation(4) = 21 bytes.
    data.activationSeconds = u32le(bytes[17], bytes[18], bytes[19], bytes[20]);
    return { data: data };
  }

  if (bytes.length < 33) {
    return { errors: ['metering frame 0x09 full variant too short: ' + bytes.length + ' bytes'] };
  }

  // Full variant.
  var activePower = s16le(bytes[17], bytes[18]);
  var reactivePower = s16le(bytes[19], bytes[20]);
  var apparentPower = s16le(bytes[21], bytes[22]);
  var voltageDv = u16le(bytes[23], bytes[24]);
  var currentMa = u16le(bytes[25], bytes[26]);
  var periodUs = u16le(bytes[27], bytes[28]);

  var power = {};
  power.active = activePower;
  power.apparent = apparentPower;
  power.voltage = round(voltageDv / 10, 1);
  power.current = round(currentMa / 1000, 3);
  if (periodUs > 0) {
    power.frequency = round(1000000 / periodUs, 2);
  }
  data.power = power;

  data.reactivePower = reactivePower;
  data.periodMicroseconds = periodUs;
  data.activationSeconds = u32le(bytes[29], bytes[30], bytes[31], bytes[32]);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enginko";
    result.data.model = "mcf-lw12met";
  }
  return result;
}
