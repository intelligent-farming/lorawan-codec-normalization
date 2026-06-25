// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LW12PLG (LoRaWAN Smart Plug
// energy meter: 230Vac / 16A load, active / reactive / apparent energy and
// power, RMS voltage and current, line frequency; Class 0.2). Enginko is the
// MCF88 rebrand.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 "Metering" 0x09 frame) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-power.js, attributed in NOTICE) and the Enginko
// "data_frame_format" documentation. Ported faithfully from the upstream
// decodeUplink/parseMetering path; we author the normalization here. The
// upstream reverseBytes/parseSigned* string-slicing helpers and the
// non-deterministic toLocaleString() date are not reused — the same
// little-endian arithmetic is performed on the byte array and the packed
// timestamp is emitted as an RFC3339 (UTC) string.
//
// Metering frame (frame id 0x09):
//   short form (<= 21 bytes):
//     0x09 | date(4 LE) | activeEnergy(4 LE, signed, Wh) |
//     reactiveEnergy(4 LE, signed, VARh) | apparentEnergy(4 LE, signed, VAh) |
//     activation(4 LE, unsigned, s)
//   long form (> 21 bytes):
//     ...as above through apparentEnergy, then
//     activePower(2 LE, signed, W) | reactivePower(2 LE, signed, VAR) |
//     apparentPower(2 LE, signed, VA) | voltage(2 LE, unsigned, dV RMS) |
//     current(2 LE, unsigned, mA RMS) | period(2 LE, unsigned, us) |
//     activation(4 LE, unsigned, s)
// Line frequency is derived from the sampling period: f = 1 / (period / 1e6).
//
// Vocabulary mapping (power-meter): metering.energy.total <- activeEnergy (Wh),
// power.active <- activePower (W), power.apparent <- apparentPower (VA),
// power.voltage <- voltage/10 (dV RMS -> V), power.current <- current/1000
// (mA RMS -> A), power.frequency <- derived (Hz). Reactive quantities, the
// raw sampling period, the on-since activation counter and the packed timestamp
// have no vocabulary key and are emitted as camelCase extras (reactiveEnergy,
// apparentEnergy, reactivePower, period, activation, time). The short frame
// carries no instantaneous channels, so it emits only metering.energy.total
// plus those extras.
//
// The upstream decoder's switch references parseTER/parseVOC/parseCo2/
// parseReportData/parseAnalog handlers that are absent from decoder-power.js;
// only the metering (0x09), time-sync (0x01), digital-data (0x10) and IO (0x0A)
// frames are actually decodable. Only the metering frame carries calibrated
// power-meter quantities, so this codec decodes 0x09 and rejects everything else.

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
  var v = u32le(b0, b1, b2, b3);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// MCF88/Enginko packed timestamp: 4 LSB bytes -> 32-bit value, fields are
// year-2000(7) month(4) day(5) hour(5) minute(6) second/2(5), MSB-first within
// the assembled word. Returns an RFC3339 string (treated as UTC).
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

  // Short metering frame: id + date + 3x4-byte energies + 4-byte activation.
  if (bytes.length < 21) {
    return { errors: ['truncated metering frame'] };
  }

  var data = {};
  var metering = { energy: {} };
  metering.energy.total = s32le(bytes[5], bytes[6], bytes[7], bytes[8]);
  data.metering = metering;

  // Reactive / apparent energy have no vocabulary key -> extras (VARh / VAh).
  data.reactiveEnergy = s32le(bytes[9], bytes[10], bytes[11], bytes[12]);
  data.apparentEnergy = s32le(bytes[13], bytes[14], bytes[15], bytes[16]);

  if (bytes.length <= 21) {
    // Short frame: only the activation counter follows the energies.
    data.activation = u32le(bytes[17], bytes[18], bytes[19], bytes[20]);
    data.time = decodeTime(bytes[1], bytes[2], bytes[3], bytes[4]);
    return { data: data };
  }

  // Long frame must carry the full instantaneous block (through activation).
  if (bytes.length < 33) {
    return { errors: ['truncated metering frame'] };
  }

  var power = {};
  power.active = s16le(bytes[17], bytes[18]);
  power.apparent = s16le(bytes[21], bytes[22]);
  power.voltage = round(u16le(bytes[23], bytes[24]) / 10, 1);
  power.current = round(u16le(bytes[25], bytes[26]) / 1000, 3);

  var period = u16le(bytes[27], bytes[28]);
  if (period > 0) {
    power.frequency = round(1 / (period / 1000000), 2);
  }
  data.power = power;

  // Reactive power and the raw sampling period have no vocabulary key -> extras.
  data.reactivePower = s16le(bytes[19], bytes[20]);
  data.period = period;
  data.activation = u32le(bytes[29], bytes[30], bytes[31], bytes[32]);
  data.time = decodeTime(bytes[1], bytes[2], bytes[3], bytes[4]);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enginko";
    result.data.model = "mcf-lw12plg";
  }
  return result;
}
