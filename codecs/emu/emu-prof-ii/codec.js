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

function emuRound(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
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

      // Active power (W).
      case 0x0b:
        if (!data.power) { data.power = {}; }
        data.power.active = emuInt32LE(bytes, i);
        break;
      case 0x0c:
        data.activePowerL1W = emuInt32LE(bytes, i);
        break;
      case 0x0d:
        data.activePowerL2W = emuInt32LE(bytes, i);
        break;
      case 0x0e:
        data.activePowerL3W = emuInt32LE(bytes, i);
        break;

      // Current (mA -> A).
      case 0x0f:
        if (!data.power) { data.power = {}; }
        data.power.current = emuRound(emuInt32LE(bytes, i) / 1000, 3);
        break;
      case 0x10:
        data.currentL1A = emuRound(emuInt32LE(bytes, i) / 1000, 3);
        break;
      case 0x11:
        data.currentL2A = emuRound(emuInt32LE(bytes, i) / 1000, 3);
        break;
      case 0x12:
        data.currentL3A = emuRound(emuInt32LE(bytes, i) / 1000, 3);
        break;
      case 0x13:
        data.currentNeutralA = emuRound(emuInt32LE(bytes, i) / 1000, 3);
        break;

      // Voltage (V/10 -> V). Use L1-N as the representative RMS voltage.
      case 0x14:
        if (!data.power) { data.power = {}; }
        data.power.voltage = emuRound(emuInt32LE(bytes, i) / 10, 1);
        break;
      case 0x15:
        data.voltageL2NV = emuRound(emuInt32LE(bytes, i) / 10, 1);
        break;
      case 0x16:
        data.voltageL3NV = emuRound(emuInt32LE(bytes, i) / 10, 1);
        break;

      // Power factor (Cos, x0.01).
      case 0x17:
        data.powerFactorL1 = emuRound(emuInt8(bytes[i]) / 100, 2);
        break;
      case 0x18:
        data.powerFactorL2 = emuRound(emuInt8(bytes[i]) / 100, 2);
        break;
      case 0x19:
        data.powerFactorL3 = emuRound(emuInt8(bytes[i]) / 100, 2);
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

  var hasVocab =
    haveEnergyImport ||
    (data.power && (
      data.power.active !== undefined ||
      data.power.voltage !== undefined ||
      data.power.current !== undefined
    ));

  if (!hasVocab) {
    if (warnings.length > 0) {
      return { data: data, warnings: warnings };
    }
    return { data: data };
  }

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
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "emu";
    result.data.model = "emu-prof-ii";
  }
  return result;
}
