// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Adeunis TIC CBE LINKY MONO — a LoRaWAN
// transmitter that reads the "Tele-Information Client" (TIC) serial bus of a
// French single-phase (monophase) Linky / CBE electricity meter and relays the
// meter registers over the air.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Adeunis frame-code + status-byte framing, 0x49 TIC data layout)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/adeunis/tic_cbe_linky_mono_lib.js,
// attributed in NOTICE). The normalization below is authored here; the upstream
// `decodeUplink` (which nests everything under `data.bytes`, never errors, and
// mis-routes the 0x30 keep-alive through the 0x20 parser) is NOT copied.
//
// The 0x49 frame carries CALIBRATED meter registers, ready for the vocabulary:
//   metering.energy.total (Wh) <- cumulative active energy index. The meter runs
//     in one of two tariff modes: BASE (single index) or HC/HP (two indexes,
//     "heures creuses" / "heures pleines"). When BASE is present it is the total;
//     otherwise the total is the sum of the HCHC + HCHP indexes (both Wh). All
//     are already in watt-hours on the wire — no conversion.
//   power.current (A)  <- IINST (instantaneous RMS current).
//   power.apparent (VA)<- PAPP  (apparent power).
// Extras (genuine meter data the vocabulary does not model): meterId (ADCO),
// tariffOption (OPTARIF), currentTariffPeriod (PTEC), subscribedCurrentA
// (ISOUSC), maxCurrentA (IMAX), and the per-tariff energy indexes when in HC/HP
// mode (energyHcWh / energyHpWh). Adeunis status flags travel as extras too.
//
// The transmitter exposes only a lowBattery status BIT (no battery voltage on
// the wire), so no `battery` key is emitted. A register absent on the serial bus
// is encoded upstream as the sentinel 0x80000000 and is simply omitted here.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, offset) {
  return (((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)) & 0xffff;
}

// Unsigned 32-bit big-endian without bitwise overflow (>0x7fffffff stays positive).
function u32be(bytes, offset) {
  return (
    ((bytes[offset] & 0xff) * 0x1000000) +
    (((bytes[offset + 1] & 0xff) << 16) |
      ((bytes[offset + 2] & 0xff) << 8) |
      (bytes[offset + 3] & 0xff))
  );
}

var NOT_FOUND = 0x80000000;

// A 32-bit register read; returns null when the serial bus reported it absent.
function reg32(bytes, offset) {
  var v = u32be(bytes, offset);
  if (v === NOT_FOUND) {
    return null;
  }
  return v;
}

// ASCII string field, trimming embedded NUL padding (mirrors upstream).
function strField(bytes, start, end) {
  var s = '';
  var i;
  for (i = start; i < end && i < bytes.length; i++) {
    if (bytes[i] !== 0x00) {
      s += String.fromCharCode(bytes[i]);
    }
  }
  return s;
}

// Adeunis status byte (payload[1]), shared across frame types. Bit semantics
// mirror the upstream TicStatusByteParser.
function applyStatus(data, statusByte) {
  data.frameCounter = (statusByte & 0xe0) >> 5;
  data.lowBattery = Boolean(statusByte & 0x02);
  data.configurationDone = Boolean(statusByte & 0x01);
  data.configurationInconsistency = Boolean(statusByte & 0x08);
  data.readError = Boolean(statusByte & 0x10);
}

// 0x49 TIC data — the metering frame.
function decodeTicData(bytes) {
  if (bytes.length < 50) {
    return { errors: ['0x49 TIC data frame too short (need 50 bytes, got ' + bytes.length + ')'] };
  }

  var adco = strField(bytes, 2, 14);
  var optarif = strField(bytes, 14, 18);
  var base = reg32(bytes, 18);
  var isousc = reg32(bytes, 22);
  var iinst = reg32(bytes, 26);
  var imax = reg32(bytes, 30);
  var papp = reg32(bytes, 34);
  var hchc = reg32(bytes, 38);
  var hchp = reg32(bytes, 42);
  var ptec = strField(bytes, 46, 50);

  var data = { frameType: '0x49 TIC data' };
  var warnings = [];

  // metering.energy.total (Wh): BASE index, or HC+HP tariff indexes summed.
  if (base !== null) {
    data.metering = { energy: { total: base } };
  } else if (hchc !== null || hchp !== null) {
    var totalEnergy = (hchc !== null ? hchc : 0) + (hchp !== null ? hchp : 0);
    data.metering = { energy: { total: totalEnergy } };
    if (hchc !== null) {
      data.energyHcWh = hchc;
    }
    if (hchp !== null) {
      data.energyHpWh = hchp;
    }
  } else {
    warnings.push('no cumulative energy index on the TIC bus (BASE/HCHC/HCHP all absent)');
  }

  // power.current (A) and power.apparent (VA).
  if (iinst !== null) {
    if (!data.power) {
      data.power = {};
    }
    data.power.current = iinst;
  }
  if (papp !== null) {
    if (!data.power) {
      data.power = {};
    }
    data.power.apparent = papp;
  }

  // Genuine meter data the vocabulary does not model -> camelCase extras.
  if (adco.length > 0) {
    data.meterId = adco;
  }
  if (optarif.length > 0) {
    data.tariffOption = optarif;
  }
  if (ptec.length > 0) {
    data.currentTariffPeriod = ptec;
  }
  if (isousc !== null) {
    data.subscribedCurrentA = isousc;
  }
  if (imax !== null) {
    data.maxCurrentA = imax;
  }

  applyStatus(data, bytes[1]);

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function productModeText(value) {
  switch (value) {
    case 0: return 'PARK';
    case 1: return 'PRODUCTION';
    case 2: return 'TEST';
    case 3: return 'DEAD';
    default: return '';
  }
}

// 0x10 TIC configuration — sampling / keep-alive periods (no meter reading).
function decodeConfig(bytes) {
  if (bytes.length < 8) {
    return { errors: ['0x10 configuration frame too short'] };
  }
  var data = { frameType: '0x10 TIC configuration' };
  if (bytes[5] === 2) {
    data.transmissionPeriodKeepAliveSec = bytes[2] * 20;
    data.samplingPeriodSec = u16be(bytes, 6) * 20;
  } else {
    data.transmissionPeriodKeepAliveMin = bytes[2] * 10;
    data.samplingPeriodMin = u16be(bytes, 6);
  }
  data.transmissionPeriodData = u16be(bytes, 3);
  data.productMode = productModeText(bytes[5]);
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x4a TIC alarm — a meter label crossed a threshold (no calibrated reading).
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

function decodeAlarm(bytes) {
  if (bytes.length < 13) {
    return { errors: ['0x4a alarm frame too short'] };
  }
  var label = strField(bytes, 2, 12);
  var value = strField(bytes, 13, bytes.length);
  var data = {
    frameType: '0x4a TIC alarm',
    alarmLabel: label.length > 0 ? label : 'notFound',
    alarmType: alarmTypeText(bytes[12]),
    alarmValue: value.length > 0 ? value : 'notFound'
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x30 keep-alive — status byte only. (Upstream mis-routes this through the
// 0x20 parser; we decode it correctly as a keep-alive.)
function decodeKeepAlive(bytes) {
  var data = { frameType: '0x30 keep alive' };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x20 LoRa configuration — network parameters (no meter reading).
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

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var frameCode = bytes[0];
  switch (frameCode) {
    case 0x49: return decodeTicData(bytes);
    case 0x10: return decodeConfig(bytes);
    case 0x20: return decodeNetworkConfig(bytes);
    case 0x30: return decodeKeepAlive(bytes);
    case 0x4a: return decodeAlarm(bytes);
    default:
      return {
        errors: [
          'unsupported frame code 0x' + frameCode.toString(16) +
            ' (Adeunis TIC CBE LINKY MONO frames 0x10, 0x20, 0x30, 0x49, 0x4a are normalized)'
        ]
      };
  }
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "tic-cbe-linky-mono";
  }
  return result;
}
