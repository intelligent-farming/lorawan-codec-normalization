// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for acrios/acr-cv-101l-m-d
// (ACR-CV-101L-M-D "M-Bus to LoRaWAN converter").
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/acrios/acr-cv-101l-m-x.js — the
// dev-lab "tmbus" M-Bus library v1.0.0, attributed in NOTICE). The device wraps
// a wired M-Bus meter frame in a 2-byte LoRaWAN header (FrameIndex, BatchFrames)
// and forwards it; fragmented multi-frame readouts are not supported (upstream
// rejects them too). The meter behind this converter is a WATER meter that
// reports its readout as an M-Bus FIXED-DATA-STRUCTURE frame (CI=0x73): two BCD
// volume counters (actual + fixed-date) with a shared unit/exponent.
//
// This codec faithfully reproduces the upstream wire decode for the fixed-data
// frame (frame framing/length/checksum checks, the C/A/CI fields, the BCD meter
// id, the access number, the application status byte, the medium/unit nibble
// packing and the two BCD counters with decimal scaling via p10). We then author
// our OWN normalization — we do not copy upstream normalizeUplink.
//
// Mapping:
//   actual Volume counter (storage 0)  -> metering.water.total (LITRES)
//     unit ml -> x0.001, l -> x1, m3 -> x1000 (see AUTHORING unit table)
//   fixed-date Volume counter          -> volumeStored (camelCase extra, litres)
//   meter id / access no / status      -> meterId, accessNo, statusByte extras
//   application-status flags           -> warnings[] (Power Low / Permanent /
//                                         Temporary / Application Busy / Error)
// The frame carries no water temperature, so water.temperature.current is not
// produced. Only Water-meter mediums are mapped to metering.water.total; any
// other medium (or a non-volume / non-fixed frame) is reported as an error so we
// never emit an uncalibrated total.

function decodeUplinkCore(input) {
  // Round to the meter's real resolution (clamp floating drift to 3 decimals;
  // ml/m3 scaling can introduce tiny binary fractions).
  function round(value, decimals) {
    var f = Math.pow(10, decimals);
    return Math.round(value * f) / f;
  }

  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short for ACR M-Bus frame header'] };
  }

  // ---- ACR LoRaWAN framing header -----------------------------------------
  // bytes[0] = FrameIndex, bytes[1] = BatchFrames. Only the single-frame case
  // (1, 1) carries a complete M-Bus telegram; anything else is a fragment.
  var frameIndex = bytes[0];
  var batchFrames = bytes[1];
  if (frameIndex !== 1 || batchFrames !== 1) {
    return { errors: ['Fragmentation not supported -> use a reassembling integration to decode fragmented frames'] };
  }

  // The remaining bytes are the raw M-Bus telegram.
  var a = bytes.slice(2);
  // Drop any leading 0xFF idle/fill bytes (upstream tmbus does the same).
  while (a.length && a[0] === 0xff) {
    a = a.slice(1);
  }

  var l = a.length;
  if (l < 5) {
    return { errors: ['M-Bus frame too short'] };
  }

  // ---- M-Bus long-frame framing (68 L L 68 ... CS 16) ----------------------
  if (a[l - 1] !== 0x16) {
    return { errors: ['M-Bus: no stop byte (0x16)'] };
  }
  if (a[0] !== 0x68) {
    return { errors: ['M-Bus: unsupported frame type (expected long frame 0x68)'] };
  }
  var fieldLen = a[1]; // L field
  if (a[2] !== a[1]) {
    return { errors: ['M-Bus: invalid length (L bytes differ)'] };
  }
  if (a[3] !== a[0]) {
    return { errors: ['M-Bus: invalid format (second start byte mismatch)'] };
  }
  if (fieldLen !== l - 6) {
    return { errors: ['M-Bus: wrong length'] };
  }

  // Checksum: arithmetic sum of bytes [4 .. e) mod 256 must equal byte e,
  // where e = l - 2 (the byte just before the 0x16 stop).
  var e = l - 2;
  var cs = 0;
  for (var ci = 4; ci < e; ci++) {
    cs = (cs + a[ci]) & 0xff;
  }
  if (cs !== a[e]) {
    return { errors: ['M-Bus: check sum failed'] };
  }

  // ---- Application layer ---------------------------------------------------
  // [4]=C, [5]=A, [6]=CI. CI 0x72/0x73/0x76/0x77 (mask 0xFA == 0x72) carry a
  // data readout; the low bit selects FIXED (1) vs variable (0) structure.
  var cField = a[4];
  var aField = a[5];
  var ciField = a[6];
  if ((ciField & 0xfa) !== 0x72) {
    return { errors: ['M-Bus: unsupported CI field 0x' + ciField.toString(16) + ' (not a data readout)'] };
  }
  var fixed = (ciField & 1) === 1;
  if (!fixed) {
    // This converter's water meter uses the fixed-data structure; the variable
    // structure is out of scope for this device's normalization.
    return { errors: ['M-Bus: variable data structure not supported by this device codec'] };
  }

  // ---- Fixed-data structure (CI=0x73), little-endian after CI --------------
  // Layout: ID(4 BCD) AccessNo(1) Status(1) Unit1(1) Unit2(1) Counter1(4 BCD) Counter2(4 BCD)
  var pos = 7;
  if (pos + 12 > e) {
    return { errors: ['M-Bus: fixed-structure frame truncated'] };
  }

  function readBcdLE(off, len) {
    // BCD, least-significant byte first.
    var v = 0;
    var mul = 1;
    for (var i = 0; i < len; i++) {
      var b = off[i];
      v += (b & 0x0f) * mul;
      mul *= 10;
      v += ((b >> 4) & 0x0f) * mul;
      mul *= 10;
    }
    return v;
  }

  var meterId = readBcdLE(a.slice(pos, pos + 4), 4);
  pos += 4;
  var accessNo = a[pos];
  pos += 1;
  var statusByte = a[pos];
  pos += 1;
  var u1 = a[pos];
  pos += 1;
  var u2 = a[pos];
  pos += 1;

  // Medium nibble (upstream m2c packing): m = (u1>>6) | ((u2>>4) & 0x0C).
  // Fixed-frame medium table fD maps this 0..16 code; 7 == Water meter,
  // 6 == Hot water meter, 18 (not reachable via fD) etc. We accept only water.
  var medium = (u1 >> 6) | ((u2 >> 4) & 0x0c);
  // fD[] from upstream: indices 0..16 -> medium class. Water-family classes we
  // accept as a water total: 7 (Water). The fixed table only ever yields the
  // codes in fD, so a direct check on the computed medium is sufficient here.
  var WATER_MEDIUM = 7;

  // ---- Unit + decimal exponent (upstream i2fu over the low 6 bits) ---------
  // For volume, the unit index = floor((code-2)/3) into the U[] table and the
  // exponent = (code-2)%3 - <prefix offset>. The volume entries in U[] are
  // ml (idx 12), l (idx 13), m3 (idx 14). We only need volume handling.
  function unitOf(code) {
    var c = code & 0x3f;
    if (c < 2) { return null; } // time/date, not a counter we map
    if (c < 0x38) {
      var idx = Math.floor((c - 2) / 3);
      var exp = (c - 2) % 3;
      // U volume block: idx 12=ml, 13=l, 14=m3. Anything outside volume is
      // energy/power/flow and not a cumulative water total.
      if (idx === 12) { return { unit: 'ml', exp: exp }; }
      if (idx === 13) { return { unit: 'l', exp: exp }; }
      if (idx === 14) { return { unit: 'm3', exp: exp }; }
      return { unit: 'other', exp: exp };
    }
    return null;
  }

  var ux = unitOf(u1 & 0x3f);
  var vyRaw = u2 & 0x3f;
  var uy;
  if (vyRaw === 0x3e) {
    uy = ux; // "same unit as counter 1"
  } else if (vyRaw === 0x3f) {
    uy = null; // unitless / unused second counter
  } else {
    uy = unitOf(vyRaw);
  }

  if (medium !== WATER_MEDIUM) {
    return { errors: ['M-Bus: medium ' + medium + ' is not a water meter; no calibrated water total'] };
  }
  if (!ux || (ux.unit !== 'ml' && ux.unit !== 'l' && ux.unit !== 'm3')) {
    return { errors: ['M-Bus: counter 1 is not a volume reading; no calibrated water total'] };
  }

  // ---- BCD counters with decimal scaling (upstream p10) --------------------
  var rawC1 = readBcdLE(a.slice(pos, pos + 4), 4);
  pos += 4;
  var rawC2 = readBcdLE(a.slice(pos, pos + 4), 4);

  function scale(raw, exp) {
    // p10: raw * 10^exp.
    return raw * Math.pow(10, exp);
  }

  function toLitres(value, unit) {
    if (unit === 'ml') { return value * 0.001; }
    if (unit === 'm3') { return value * 1000; }
    return value; // litres
  }

  var actualVolume = scale(rawC1, ux.exp);
  var totalLitres = round(toLitres(actualVolume, ux.unit), 3);

  // ---- Application status flags -> warnings (upstream deS semantics) -------
  var warnings = [];
  if (statusByte & 0x04) { warnings.push('Power Low'); }
  if (statusByte & 0x08) { warnings.push('Permanent Error'); }
  if (statusByte & 0x10) { warnings.push('Temporary Error'); }
  // For fixed frames, the low 2 bits indicate the stored-data origin, not the
  // busy/error pair used by variable frames, so they are reported as cStored.
  var cStored = (statusByte & 2) ? 'At fixed date' : 'Actual';

  var data = {
    'metering.water.total': totalLitres,
    meterId: meterId,
    accessNo: accessNo,
    statusByte: statusByte,
    deviceType: 'Water meter',
    cStored: cStored
  };

  // Second counter (fixed-date stored reading) as a litres extra, when present.
  if (uy && (uy.unit === 'ml' || uy.unit === 'l' || uy.unit === 'm3')) {
    var storedVolume = scale(rawC2, uy.exp);
    data.volumeStored = round(toLitres(storedVolume, uy.unit), 3);
  }

  if (warnings.length) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "acrios";
    result.data.model = "acr-cv-101l-m-d";
  }
  return result;
}
