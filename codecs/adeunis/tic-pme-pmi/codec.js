// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Adeunis TIC PME-PMI electricity-meter
// interface (reads the "Télé-Information Client" serial bus of a French
// PME-PMI tariff meter and forwards its registers over LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Adeunis frame-code + status-byte framing) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/adeunis/tic_pme_pmi_lib.js, attributed in NOTICE). The normalization
// below is authored here; the upstream `decodeUplink` (which nests everything
// under `data.bytes` and never errors) is NOT copied.
//
// CALIBRATED ENERGY: the 0x49 TIC-data frame carries EA_s, the meter's running
// total active-energy index, directly in watt-hours. It maps straight to the
// vocabulary key `metering.energy.total` (Wh) with no conversion — satisfying
// the power-meter category. The meter reports no instantaneous voltage, current
// or active power on this product (PME-PMI exposes cumulative tariff registers
// and a reactive/apparent-energy set, not live V/A/W), so only
// metering.energy.total is emitted; the remaining registers (reactive energy
// varh/kvarh, apparent energy VAh, the kWh period indexes, the active tariff
// period PTCOUR1, and the meter DATE timestamp) are preserved as camelCase
// extras because the vocabulary does not model them.
//
// A meter register that reads the sentinel 0x80000000 is "not found" on the TIC
// bus; such a register is omitted and a warning is emitted. If EA_s itself is
// not found, no metering.energy.total can be produced.
//
// Frames normalized:
//   0x49 TIC data    — meter registers (the calibrated energy frame).
//   0x10 TIC config  — sampling/transmission periods (camelCase extras).
//   0x4a TIC alarm   — a threshold alarm on a named register (extras).
//   0x20 config      — LoRa network configuration (extras).
//   0x30 keep alive  — status byte only.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, offset) {
  return (((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)) & 0xffff;
}

function u32be(bytes, offset) {
  return (
    ((bytes[offset] & 0xff) * 0x1000000) +
    (((bytes[offset + 1] & 0xff) << 16) |
      ((bytes[offset + 2] & 0xff) << 8) |
      (bytes[offset + 3] & 0xff))
  );
}

var NOT_FOUND = 0x80000000;

// Status byte (payload[1]) common to every Adeunis frame; the TIC variant adds
// configurationInconsistency and readError bits.
function applyStatus(data, statusByte) {
  data.frameCounter = (statusByte & 0xe0) >> 5;
  data.lowBattery = Boolean(statusByte & 0x02);
  data.configurationDone = Boolean(statusByte & 0x01);
  data.configurationInconsistency = Boolean(statusByte & 0x08);
  data.readError = Boolean(statusByte & 0x10);
}

// Reads a 4-byte big-endian meter register starting at `offset`. Returns the
// numeric value, or null if it carries the TIC "not found" sentinel.
function readRegister(bytes, offset) {
  var v = u32be(bytes, offset);
  if (v === NOT_FOUND) {
    return null;
  }
  return v;
}

// Reads an ASCII label (non-zero bytes) from [start, end).
function readString(bytes, start, end) {
  var s = '';
  var i;
  for (i = start; i < end; i++) {
    if (bytes[i] !== 0x00) {
      s += String.fromCharCode(bytes[i]);
    }
  }
  return s;
}

function p2d(value) {
  return ('0' + value).slice(-2);
}

// 0x49 TIC data: PME-PMI register set. EA_s (offset 8, Wh) is the calibrated
// cumulative active energy.
function decodeTicData(bytes) {
  if (bytes.length < 51) {
    return { errors: ['0x49 TIC data frame too short'] };
  }

  var warnings = [];
  var data = { frameType: '0x49 TIC data' };
  applyStatus(data, bytes[1]);

  // DATE (offset 2..7): DD MM YY hh mm ss -> RFC3339-style local timestamp.
  var dateStr =
    (2000 + bytes[4]) + '-' + p2d(bytes[3]) + '-' + p2d(bytes[2]) +
    'T' + p2d(bytes[5]) + ':' + p2d(bytes[6]) + ':' + p2d(bytes[7]);
  data.meterDate = dateStr;

  // EA_s (offset 8, Wh): cumulative active energy -> metering.energy.total.
  var eaWh = readRegister(bytes, 8);
  if (eaWh === null) {
    warnings.push('EA_s (total active energy) not found on the TIC bus');
  } else {
    data.metering = { energy: { total: round(eaWh, 0) } };
  }

  // Reactive / apparent energy and period indexes have no vocabulary home.
  var erPlus = readRegister(bytes, 12);
  if (erPlus !== null) { data.reactiveEnergyImportVarh = round(erPlus, 0); }
  var erMinus = readRegister(bytes, 16);
  if (erMinus !== null) { data.reactiveEnergyExportVarh = round(erMinus, 0); }
  var eapp = readRegister(bytes, 20);
  if (eapp !== null) { data.apparentEnergyVah = round(eapp, 0); }

  var ptcour1 = readString(bytes, 24, 27);
  if (ptcour1.length > 0) { data.tariffPeriod = ptcour1; }

  var eap = readRegister(bytes, 27);
  if (eap !== null) { data.activeEnergyPeriodKwh = round(eap, 0); }
  var erpPlus = readRegister(bytes, 31);
  if (erpPlus !== null) { data.reactiveEnergyImportPeriodKvarh = round(erpPlus, 0); }
  var erpMinus = readRegister(bytes, 35);
  if (erpMinus !== null) { data.reactiveEnergyExportPeriodKvarh = round(erpMinus, 0); }
  var eapPrev = readRegister(bytes, 39);
  if (eapPrev !== null) { data.activeEnergyPreviousPeriodKwh = round(eapPrev, 0); }
  var erpPlusPrev = readRegister(bytes, 43);
  if (erpPlusPrev !== null) { data.reactiveEnergyImportPreviousPeriodKvarh = round(erpPlusPrev, 0); }
  var erpMinusPrev = readRegister(bytes, 47);
  if (erpMinusPrev !== null) { data.reactiveEnergyExportPreviousPeriodKvarh = round(erpMinusPrev, 0); }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// 0x10 TIC configuration: keep-alive / sampling periods.
function decodeConfig(bytes) {
  if (bytes.length < 8) {
    return { errors: ['0x10 TIC configuration frame too short'] };
  }
  var productMode = bytes[5];
  var data = { frameType: '0x10 TIC configuration' };
  if (productMode === 2) {
    data.transmissionPeriodKeepAliveSec = bytes[2] * 20;
    data.samplingPeriodSec = u16be(bytes, 6) * 20;
  } else {
    data.transmissionPeriodKeepAliveMin = bytes[2] * 10;
    data.samplingPeriodMin = u16be(bytes, 6);
  }
  data.transmissionPeriodData = u16be(bytes, 3);
  applyStatus(data, bytes[1]);
  return { data: data };
}

function alarmTypeText(value) {
  switch (value) {
    case 0: return 'manualTrigger';
    case 1: return 'labelAppearance';
    case 2: return 'labelDisappearance';
    case 3: return 'highThreshold';
    case 4: return 'lowThreshold';
    case 5: return 'endThresholdAlarm';
    case 6: return 'deltaPositive';
    case 7: return 'deltaNegative';
    default: return '';
  }
}

// 0x4a TIC alarm: alarm on a named register.
function decodeAlarm(bytes) {
  if (bytes.length < 13) {
    return { errors: ['0x4a TIC alarm frame too short'] };
  }
  var label = readString(bytes, 2, 12);
  var value = readString(bytes, 13, bytes.length);
  var data = {
    frameType: '0x4a TIC alarm',
    alarmLabel: label.length > 0 ? label : 'notFound',
    alarmType: alarmTypeText(bytes[12]),
    alarmValue: value.length > 0 ? value : 'notFound'
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x20 LoRa network configuration.
function decodeNetworkConfig(bytes) {
  if (bytes.length !== 4) {
    return { errors: ['0x20 configuration frame has unsupported length ' + bytes.length] };
  }
  var data = {
    frameType: '0x20 configuration',
    loraAdr: Boolean(bytes[2] & 0x01),
    loraProvisioningMode: bytes[3] === 0 ? 'ABP' : 'OTAA',
    loraDutycycle: bytes[2] & 0x04 ? 'activated' : 'deactivated',
    loraClassMode: bytes[2] & 0x20 ? 'CLASS C' : 'CLASS A'
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x30 keep alive: status byte only.
function decodeKeepAlive(bytes) {
  var data = { frameType: '0x30 keep alive' };
  applyStatus(data, bytes[1]);
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var frameCode = bytes[0];
  switch (frameCode) {
    case 0x49: return decodeTicData(bytes);
    case 0x10: return decodeConfig(bytes);
    case 0x4a: return decodeAlarm(bytes);
    case 0x20: return decodeNetworkConfig(bytes);
    case 0x30: return decodeKeepAlive(bytes);
    default:
      return {
        errors: [
          'unsupported frame code 0x' + frameCode.toString(16) +
            ' (Adeunis TIC PME-PMI frames 0x10, 0x20, 0x30, 0x49, 0x4a are normalized)'
        ]
      };
  }
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "tic-pme-pmi";
  }
  return result;
}
