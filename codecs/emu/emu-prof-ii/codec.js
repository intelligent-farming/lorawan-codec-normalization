// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for emu/emu-prof-ii (EMU Professional II LoRa,
// 3-phase MID energy meter).
//
// Wire format understood from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/emu/profii-lp-codec_generic.js,
// attributed in NOTICE). Normalization below is authored for this repo; the
// upstream normalizeUplink/Decode output is NOT copied.
//
// Frame layout: bytes[0..3] little-endian Uint32 datalogger timestamp,
// then a stream of records (1 signature byte + fixed-length little-endian
// payload per the signature table), then a trailing CRC-8 byte.
//
// Per-conductor readings ride in `channels[]`
// ------------------------------------------
// The signature table separates records that measure ONE conductor from records
// that describe the whole meter (upstream `dataTypes`, reference/
// upstream-codec.js). Every per-conductor record is a sub-sensor position
// measuring the same physical quantity, so its reading goes in the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") instead of the
// suffixed extras this codec used to emit (`activePowerL1W`..`L3W`,
// `currentL1A`..`L3A`, `currentNeutralA`, `voltageL2NV`/`L3NV`,
// `powerFactorL1`..`L3`). Four positions, labelled after the conductor the
// record names — `phaseA`/`phaseB`/`phaseC` for L1/L2/L3 (the label scheme the
// three-phase arwin-technology/lrs2m001-4xxx and netvox/r718n3 meters use for
// this concept) and `neutral` for N:
//   phaseA <- 0x0C ActivePowerL1  -> power.active  (W)
//             0x10 CurrentL1      -> power.current (A; mA / 1000)
//             0x14 VoltageL1-N    -> power.voltage (V; raw / 10)
//             0x17 PowerfactorL1  -> powerFactor   (extra; Cos x0.01)
//   phaseB <- 0x0D / 0x11 / 0x15 / 0x18   (same four quantities for L2)
//   phaseC <- 0x0E / 0x12 / 0x16 / 0x19   (same four quantities for L3)
//   neutral <- 0x13 CurrentN      -> power.current (A; mA / 1000)
// 0x14 VoltageL1-N used to be promoted to a bare top-level `power.voltage`
// while only L2/L3 were suffixed extras; it is L1's phase-to-neutral voltage
// like any other per-phase record (upstream marks it cfgphase 1), so it now sits
// in `phaseA` and no top-level `power.voltage` is emitted at all.
// `neutral` is a channels entry rather than a top-level `currentNeutralA` extra
// because it is the same measured quantity (RMS current) at a distinct physical
// conductor — exactly the channels[] criterion — even though the neutral is not
// one of the three phases; upstream tags it cfgphase 4, i.e. the meter itself
// treats it as a fourth position.
// `powerFactor` stays an extra rather than the vocabulary's `power.factor`: it
// is only being moved out of a suffixed name in this pass, and promoting an
// extra to a vocabulary key is a separate normalization decision.
//
// Whole-meter records stay top-level (never repeated inside an entry):
//   0x0B ActivePowerL123 -> power.active   (W)  the meter's own three-phase sum
//   0x0F CurrentL123     -> power.current  (A)  the meter's own current total
//   0x1A Frequency       -> power.frequency(Hz) line frequency, not per phase
//   0x03/0x04, 0x1C/0x1D, 0x24/0x25 -> metering.energy.total (Wh, accumulated)
// 0x0B/0x0F are aggregates the METER reports (not a promoted phase and not
// summed by us), so they describe the whole device and belong to the empty
// channel label; a frame carrying both them and the per-phase records emits the
// aggregate top-level and the phases in entries, and no single reading is ever
// emitted twice. Also top-level, all of it whole-device: the tariff energy
// registers (activeEnergyImportT1Wh/T2Wh, activeEnergyExportT1Wh/T2Wh,
// reactiveEnergy*T1Varh/T2Varh) — these are TARIFF BUCKETS of one meter-wide
// register, not physical positions, so they are deliberately NOT channels[]
// entries and must not be "fixed" into any; plus activePowerAverageW,
// dataLoggerIndex, recordTimestamp/recordTimestampPrevious, systemTime,
// timeStamp/time, errorCode and the meter identity/config extras (meterType,
// serialNumber, factorNumber, midYear, midVersion, factoryYear,
// firmwareVersion, manufacturer, hwIndex, currentTransformerPrimary/Secondary,
// voltageTransformerPrimary/Secondary).
//
// Lazy build: records arrive selectively (the datalogger profile decides which
// signatures a frame carries), so an entry is created only when a record for
// that position appears, and `channels` is omitted entirely when a frame carries
// none — an energy-totals frame emits no `channels` key, a phase-current frame
// emits three entries holding just `power.current`, and a frame with only
// 0x14 emits a single `phaseA` entry holding just `power.voltage`.
//
// Sentinel policy: there is none to honour. The wire format has no
// absent/disconnected-conductor encoding — every per-conductor record is a plain
// signed little-endian value with no reserved code, and 0 (unloaded phase, open
// CT) is a legitimate reading — so no position is ever skipped for its value and
// a position is missing from `channels` only when the frame carried no record
// for it. Frame-level corruption is reported as it always was: a CRC-8 mismatch
// or a truncated/unknown record yields a warning and the records parsed so far.

function emuRound(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Reserved channels[] positions, in emitted order: the three supply phases then
// the neutral conductor. Slot index matches the conductor's position in the
// signature table (L1, L2, L3, N).
var EMU_POSITION_LABELS = ['phaseA', 'phaseB', 'phaseC', 'neutral'];

// Lazily create (and return) the channels entry for one conductor.
function emuPosition(slots, idx) {
  if (slots[idx] === null) {
    slots[idx] = { channel: EMU_POSITION_LABELS[idx] };
  }
  return slots[idx];
}

// Set one power.* vocabulary key inside a conductor's channels entry.
function emuPositionPower(slots, idx, key, value) {
  var entry = emuPosition(slots, idx);
  if (!entry.power) {
    entry.power = {};
  }
  entry.power[key] = value;
}

function emuUint32LE(b, off) {
  return (
    (b[off] >>> 0) +
    (b[off + 1] << 8 >>> 0) * 1 +
    b[off + 2] * 65536 +
    b[off + 3] * 16777216
  );
}

function emuUint16LE(b, off) {
  return b[off] + b[off + 1] * 256;
}

function emuInt32LE(b, off) {
  var v = b[off] + b[off + 1] * 256 + b[off + 2] * 65536 + b[off + 3] * 16777216;
  if (v >= 2147483648) {
    v = v - 4294967296;
  }
  return v;
}

function emuInt16LE(b, off) {
  var v = b[off] + b[off + 1] * 256;
  if (v >= 32768) {
    v = v - 65536;
  }
  return v;
}

function emuInt8(b) {
  var v = b & 0xff;
  if (v >= 128) {
    v = v - 256;
  }
  return v;
}

// uInt64 as a plain Number (Wh registers stay well within 2^53).
function emuUint64LE(b, off) {
  var lo = emuUint32LE(b, off);
  var hi = emuUint32LE(b, off + 4);
  return hi * 4294967296 + lo;
}

function emuBCD(b, off, n) {
  var s = "";
  var i;
  for (i = 0; i < n; i++) {
    s = s + b[off + i].toString();
  }
  return s;
}

function emuASCII(b, off, n) {
  var s = "";
  var i;
  for (i = 0; i < n; i++) {
    var c = b[off + i] & 0xff;
    if (c !== 0) {
      s = s + String.fromCharCode(c);
    }
  }
  return s;
}

var EMU_CRC8_TABLE = [
  0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15, 0x38, 0x3f, 0x36, 0x31,
  0x24, 0x23, 0x2a, 0x2d, 0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65,
  0x48, 0x4f, 0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d, 0xe0, 0xe7, 0xee, 0xe9,
  0xfc, 0xfb, 0xf2, 0xf5, 0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd,
  0x90, 0x97, 0x9e, 0x99, 0x8c, 0x8b, 0x82, 0x85, 0xa8, 0xaf, 0xa6, 0xa1,
  0xb4, 0xb3, 0xba, 0xbd, 0xc7, 0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2,
  0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4, 0xed, 0xea, 0xb7, 0xb0, 0xb9, 0xbe,
  0xab, 0xac, 0xa5, 0xa2, 0x8f, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9d, 0x9a,
  0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32, 0x1f, 0x18, 0x11, 0x16,
  0x03, 0x04, 0x0d, 0x0a, 0x57, 0x50, 0x59, 0x5e, 0x4b, 0x4c, 0x45, 0x42,
  0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a, 0x89, 0x8e, 0x87, 0x80,
  0x95, 0x92, 0x9b, 0x9c, 0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3, 0xa4,
  0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec, 0xc1, 0xc6, 0xcf, 0xc8,
  0xdd, 0xda, 0xd3, 0xd4, 0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c,
  0x51, 0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44, 0x19, 0x1e, 0x17, 0x10,
  0x05, 0x02, 0x0b, 0x0c, 0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34,
  0x4e, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5c, 0x5b, 0x76, 0x71, 0x78, 0x7f,
  0x6a, 0x6d, 0x64, 0x63, 0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b,
  0x06, 0x01, 0x08, 0x0f, 0x1a, 0x1d, 0x14, 0x13, 0xae, 0xa9, 0xa0, 0xa7,
  0xb2, 0xb5, 0xbc, 0xbb, 0x96, 0x91, 0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83,
  0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc, 0xcb, 0xe6, 0xe1, 0xe8, 0xef,
  0xfa, 0xfd, 0xf4, 0xf3
];

function emuCrc8(b, len) {
  var crc = 0;
  var i;
  for (i = 0; i < len; i++) {
    crc = EMU_CRC8_TABLE[(crc ^ b[i]) & 0xff];
  }
  return crc & 0xff;
}

// Record length per signature byte; 0 means "unknown / unsupported".
function emuRecordLen(sig) {
  if (sig === 0x00) { return 4; }
  if (sig === 0x01 || sig === 0x02) { return 4; }
  if (sig >= 0x03 && sig <= 0x16) { return 4; }
  if (sig >= 0x17 && sig <= 0x19) { return 1; }
  if (sig === 0x1a) { return 2; }
  if (sig >= 0x1b && sig <= 0x23) { return 4; }
  if (sig >= 0x24 && sig <= 0x2b) { return 8; }
  if (sig === 0xf0) { return 1; }
  if (sig >= 0xf1 && sig <= 0xf2) { return 4; }
  if (sig >= 0xf3 && sig <= 0xf6) { return 2; }
  if (sig === 0xf7) { return 1; }
  if (sig >= 0xf8 && sig <= 0xfd) { return 4; }
  if (sig === 0xfe) { return 4; }
  return 0;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  // A 2-byte (or shorter) frame is a status-only uplink with no measurement.
  if (bytes.length <= 2) {
    return { errors: ['status-only uplink, no measurement data'] };
  }
  if (bytes.length < 6) {
    return { errors: ['payload too short for timestamp + record + crc'] };
  }

  var warnings = [];

  // CRC-8 over everything except the trailing CRC byte.
  var crcReceived = bytes[bytes.length - 1] & 0xff;
  var crcCalc = emuCrc8(bytes, bytes.length - 1);
  if (crcCalc !== crcReceived) {
    warnings.push('crc-8 mismatch');
  }

  var data = {};

  var timeStamp = emuUint32LE(bytes, 0);
  data.timeStamp = timeStamp;
  data.time = new Date(timeStamp * 1000).toISOString();

  // Cumulative active energy import accumulator (Wh) across tariffs.
  var energyImportWh = 0;
  var haveEnergyImport = false;

  // channels[] entries per measured conductor (L1, L2, L3, N), created only
  // when the frame actually carries a record for that position.
  var slots = [null, null, null, null];

  var i = 4;
  var end = bytes.length - 1; // exclude CRC byte
  while (i < end) {
    var sig = bytes[i] & 0xff;
    var len = emuRecordLen(sig);
    if (len === 0) {
      warnings.push('unknown record signature 0x' + sig.toString(16));
      break;
    }
    i++;
    if (i + len > end) {
      warnings.push('truncated record 0x' + sig.toString(16));
      break;
    }

    switch (sig) {
      case 0x01:
        data.recordTimestamp = emuUint32LE(bytes, i);
        break;
      case 0x02:
        data.recordTimestampPrevious = emuUint32LE(bytes, i);
        break;
      case 0x00:
        data.dataLoggerIndex = emuUint32LE(bytes, i);
        break;

      // Active energy import (Wh) — cumulative, summed across tariffs.
      case 0x03:
        energyImportWh += emuUint32LE(bytes, i);
        haveEnergyImport = true;
        data.activeEnergyImportT1Wh = emuUint32LE(bytes, i);
        break;
      case 0x04:
        energyImportWh += emuUint32LE(bytes, i);
        haveEnergyImport = true;
        data.activeEnergyImportT2Wh = emuUint32LE(bytes, i);
        break;
      // Active energy export (Wh) — extras.
      case 0x05:
        data.activeEnergyExportT1Wh = emuUint32LE(bytes, i);
        break;
      case 0x06:
        data.activeEnergyExportT2Wh = emuUint32LE(bytes, i);
        break;
      // Reactive energy (varh) — extras.
      case 0x07:
        data.reactiveEnergyImportT1Varh = emuUint32LE(bytes, i);
        break;
      case 0x08:
        data.reactiveEnergyImportT2Varh = emuUint32LE(bytes, i);
        break;
      case 0x09:
        data.reactiveEnergyExportT1Varh = emuUint32LE(bytes, i);
        break;
      case 0x0a:
        data.reactiveEnergyExportT2Varh = emuUint32LE(bytes, i);
        break;

      // Active power (W). L123 is the meter's own three-phase total (whole
      // device); L1/L2/L3 are per-conductor and ride in their channels entry.
      case 0x0b:
        if (!data.power) { data.power = {}; }
        data.power.active = emuInt32LE(bytes, i);
        break;
      case 0x0c:
        emuPositionPower(slots, 0, 'active', emuInt32LE(bytes, i));
        break;
      case 0x0d:
        emuPositionPower(slots, 1, 'active', emuInt32LE(bytes, i));
        break;
      case 0x0e:
        emuPositionPower(slots, 2, 'active', emuInt32LE(bytes, i));
        break;

      // Current (mA -> A). L123 is the meter's own total; L1/L2/L3/N are the
      // four measured conductors.
      case 0x0f:
        if (!data.power) { data.power = {}; }
        data.power.current = emuRound(emuInt32LE(bytes, i) / 1000, 3);
        break;
      case 0x10:
        emuPositionPower(slots, 0, 'current', emuRound(emuInt32LE(bytes, i) / 1000, 3));
        break;
      case 0x11:
        emuPositionPower(slots, 1, 'current', emuRound(emuInt32LE(bytes, i) / 1000, 3));
        break;
      case 0x12:
        emuPositionPower(slots, 2, 'current', emuRound(emuInt32LE(bytes, i) / 1000, 3));
        break;
      case 0x13:
        emuPositionPower(slots, 3, 'current', emuRound(emuInt32LE(bytes, i) / 1000, 3));
        break;

      // Voltage (V/10 -> V). All three are phase-to-neutral voltages of one
      // phase each, L1-N included — no whole-meter voltage exists.
      case 0x14:
        emuPositionPower(slots, 0, 'voltage', emuRound(emuInt32LE(bytes, i) / 10, 1));
        break;
      case 0x15:
        emuPositionPower(slots, 1, 'voltage', emuRound(emuInt32LE(bytes, i) / 10, 1));
        break;
      case 0x16:
        emuPositionPower(slots, 2, 'voltage', emuRound(emuInt32LE(bytes, i) / 10, 1));
        break;

      // Power factor (Cos, x0.01) — per phase, extra inside that phase's entry.
      case 0x17:
        emuPosition(slots, 0).powerFactor = emuRound(emuInt8(bytes[i]) / 100, 2);
        break;
      case 0x18:
        emuPosition(slots, 1).powerFactor = emuRound(emuInt8(bytes[i]) / 100, 2);
        break;
      case 0x19:
        emuPosition(slots, 2).powerFactor = emuRound(emuInt8(bytes[i]) / 100, 2);
        break;

      // Frequency (Hz, x0.1).
      case 0x1a:
        if (!data.power) { data.power = {}; }
        data.power.frequency = emuRound(emuInt16LE(bytes, i) / 10, 1);
        break;

      // Active power average (W).
      case 0x1b:
        data.activePowerAverageW = emuInt32LE(bytes, i);
        break;

      // Active energy import (kWh -> Wh), cumulative across tariffs.
      case 0x1c:
        energyImportWh += emuUint32LE(bytes, i) * 1000;
        haveEnergyImport = true;
        data.activeEnergyImportT1Wh = emuUint32LE(bytes, i) * 1000;
        break;
      case 0x1d:
        energyImportWh += emuUint32LE(bytes, i) * 1000;
        haveEnergyImport = true;
        data.activeEnergyImportT2Wh = emuUint32LE(bytes, i) * 1000;
        break;
      case 0x1e:
        data.activeEnergyExportT1Wh = emuUint32LE(bytes, i) * 1000;
        break;
      case 0x1f:
        data.activeEnergyExportT2Wh = emuUint32LE(bytes, i) * 1000;
        break;
      case 0x20:
        data.reactiveEnergyImportT1Varh = emuUint32LE(bytes, i) * 1000;
        break;
      case 0x21:
        data.reactiveEnergyImportT2Varh = emuUint32LE(bytes, i) * 1000;
        break;
      case 0x22:
        data.reactiveEnergyExportT1Varh = emuUint32LE(bytes, i) * 1000;
        break;
      case 0x23:
        data.reactiveEnergyExportT2Varh = emuUint32LE(bytes, i) * 1000;
        break;

      // 64-bit active energy import (Wh), cumulative across tariffs.
      case 0x24:
        energyImportWh += emuUint64LE(bytes, i);
        haveEnergyImport = true;
        data.activeEnergyImportT1Wh = emuUint64LE(bytes, i);
        break;
      case 0x25:
        energyImportWh += emuUint64LE(bytes, i);
        haveEnergyImport = true;
        data.activeEnergyImportT2Wh = emuUint64LE(bytes, i);
        break;
      case 0x26:
        data.activeEnergyExportT1Wh = emuUint64LE(bytes, i);
        break;
      case 0x27:
        data.activeEnergyExportT2Wh = emuUint64LE(bytes, i);
        break;
      case 0x28:
        data.reactiveEnergyImportT1Varh = emuUint64LE(bytes, i);
        break;
      case 0x29:
        data.reactiveEnergyImportT2Varh = emuUint64LE(bytes, i);
        break;
      case 0x2a:
        data.reactiveEnergyExportT1Varh = emuUint64LE(bytes, i);
        break;
      case 0x2b:
        data.reactiveEnergyExportT2Varh = emuUint64LE(bytes, i);
        break;

      // Meter info / diagnostics.
      case 0xf0:
        data.errorCode = bytes[i] & 0xff;
        break;
      case 0xf1:
        data.serialNumber = emuMeterSerial(bytes, i);
        break;
      case 0xf2:
        data.factorNumber = emuMeterSerial(bytes, i);
        break;
      case 0xf3:
        data.currentTransformerPrimary = emuUint16LE(bytes, i);
        break;
      case 0xf4:
        data.currentTransformerSecondary = emuUint16LE(bytes, i);
        break;
      case 0xf5:
        data.voltageTransformerPrimary = emuUint16LE(bytes, i);
        break;
      case 0xf6:
        data.voltageTransformerSecondary = emuUint16LE(bytes, i);
        break;
      case 0xf7:
        data.meterType = bytes[i] & 0xff;
        break;
      case 0xf8:
        data.midYear = emuBCD(bytes, i, 4);
        break;
      case 0xf9:
        data.factoryYear = emuBCD(bytes, i, 4);
        break;
      case 0xfa:
        data.firmwareVersion = emuASCII(bytes, i, 4);
        break;
      case 0xfb:
        data.midVersion = emuASCII(bytes, i, 4);
        break;
      case 0xfc:
        data.manufacturer = emuASCII(bytes, i, 4);
        break;
      case 0xfd:
        data.hwIndex = emuASCII(bytes, i, 4);
        break;
      case 0xfe:
        data.systemTime = emuUint32LE(bytes, i);
        break;
      default:
        break;
    }
    i += len;
  }

  if (haveEnergyImport) {
    if (!data.metering) { data.metering = {}; }
    if (!data.metering.energy) { data.metering.energy = {}; }
    data.metering.energy.total = energyImportWh;
  }

  // Emit the conductor entries in fixed order (L1, L2, L3, N), skipping
  // positions this frame said nothing about; a frame with no per-conductor
  // record at all carries no `channels` key.
  var entries = [];
  var slot;
  for (slot = 0; slot < slots.length; slot++) {
    if (slots[slot] !== null) {
      entries.push(slots[slot]);
    }
  }
  if (entries.length > 0) {
    data.channels = entries;
  }

  // A frame may legitimately carry no vocabulary key at all (meter identity /
  // diagnostics records only); that still decodes, with any frame-level warning.
  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function emuMeterSerial(b, off) {
  var s = "";
  var i;
  for (i = 0; i < 4; i++) {
    var hex = ('0' + (b[off + i] & 0xff).toString(16)).slice(-2);
    s = hex + s;
  }
  return s;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "emu", model: "emu-prof-ii" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "emu";
    result.data.model = "emu-prof-ii";
  }
  return result;
}
