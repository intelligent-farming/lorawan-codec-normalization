// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Adeunis TIC CBE LINKY TRI — a LoRaWAN
// transmitter that reads the "Tele-Information Client" (TIC) serial bus of a
// French three-phase (triphase) Linky / CBE electricity meter and relays the
// meter registers over the air.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Adeunis frame-code + status-byte framing, 0x49 TIC data layout)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/adeunis/tic_cbe_linky_tri_lib.js,
// attributed in NOTICE). The normalization below is authored here; the upstream
// `decodeUplink` (which nests everything under `data.bytes`, never errors, and
// mis-routes the 0x30 keep-alive through the 0x20 parser) is NOT copied.
//
// The 0x49 frame carries CALIBRATED meter registers, ready for the vocabulary.
// Its three-phase layout splits cleanly into per-phase registers and
// whole-meter registers (upstream Tic0x49Parser, `ticCbeLinkyTri` branch):
//   per phase: IINST1/2/3 (instantaneous RMS current, A)
//              IMAX1/2/3  (maximum current reached, A)
//   whole meter: BASE (cumulative active-energy index, Wh), PMAX (maximum
//              active power, W), PAPP (apparent power, VA), ADCO (meter id).
//
// The three supply phases are three sub-sensor positions measuring the same
// quantity, so their readings ride in the reserved `channels` array (see
// AUTHORING.md "Multi-channel devices") instead of the suffixed extras this
// codec used to emit (`currentL2A`, `currentL3A`, `maxCurrentL1A`/`L2A`/`L3A`)
// with phase 1 promoted to the bare `power.current`. One entry per phase:
//   IINST<N> -> power.current (A, unchanged: already amperes on the wire)
//   IMAX<N>  -> maxCurrent    (extra: that phase's own maximum — per-position
//               data belongs in its own position's entry)
// Labels are `phaseA`/`phaseB`/`phaseC` after the register's 1-based suffix
// (IINST1 -> phaseA), the same label scheme the three-phase
// arwin-technology/lrs2m001-4xxx and netvox/r718n3 meters use for this concept.
// Deliberately NOT `channelA`/`channelB` like the sibling adeunis codecs
// (pulse-4, pulse-nb-iot, analog): those label this vendor's independent
// *interface channels* (separate pulse inputs / analog inputs), whereas these
// are the three phases of one supply — a different concept, hence a different
// label prefix.
//
// Whole-meter registers stay top-level and are never repeated inside an entry:
// metering.energy.total (BASE), power.active (PMAX), power.apparent (PAPP), the
// meterId extra (ADCO), plus frameType and the Adeunis status extras
// (frameCounter, lowBattery, configurationDone, configurationInconsistency,
// readError). PMAX/PAPP are single meter-wide registers in the TRI layout — the
// TIC bus carries no per-phase power or energy — so nothing else moves.
//
// The transmitter exposes only a lowBattery status BIT (no battery voltage on
// the wire), so no `battery` key is emitted.
//
// Sentinel / absent-phase policy: a register the serial bus did not report is
// encoded upstream as 0x80000000 and is simply omitted here — so a phase whose
// IINST is absent yields an entry with only `maxCurrent`, and a phase with both
// registers absent yields no entry at all. `channels` itself is omitted when no
// phase reported anything (an all-sentinel TIC read). There is no separate
// "disconnected phase" encoding on the wire: 0 A is a legitimate reading (idle
// phase), not a sentinel, and is emitted as measured.
//
// The single-phase sibling codecs/adeunis/tic-cbe-linky-mono is intentionally
// left flat: one phase is one position, so its IINST/IMAX have no sibling to be
// confused with and need no channels[] entry.

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

// Supply-phase labels for the reserved channels[] entries, indexed by the
// 1-based suffix the TIC registers use (IINST1 -> phaseA).
var TIC_TRI_PHASE_LABELS = ['phaseA', 'phaseB', 'phaseC'];

// Adeunis status byte (payload[1]), shared across frame types. Bit semantics
// mirror the upstream TicStatusByteParser.
function applyStatus(data, statusByte) {
  data.frameCounter = (statusByte & 0xe0) >> 5;
  data.lowBattery = Boolean(statusByte & 0x02);
  data.configurationDone = Boolean(statusByte & 0x01);
  data.configurationInconsistency = Boolean(statusByte & 0x08);
  data.readError = Boolean(statusByte & 0x10);
}

// 0x49 TIC data — the metering frame (three-phase layout).
function decodeTicData(bytes) {
  if (bytes.length < 50) {
    return { errors: ['0x49 TIC data frame too short (need 50 bytes, got ' + bytes.length + ')'] };
  }

  var adco = strField(bytes, 2, 14);
  var base = reg32(bytes, 14);
  var iinst1 = reg32(bytes, 18);
  var iinst2 = reg32(bytes, 22);
  var iinst3 = reg32(bytes, 26);
  var imax1 = reg32(bytes, 30);
  var imax2 = reg32(bytes, 34);
  var imax3 = reg32(bytes, 38);
  var pmax = reg32(bytes, 42);
  var papp = reg32(bytes, 46);

  var data = { frameType: '0x49 TIC data' };
  var warnings = [];

  // metering.energy.total (Wh): BASE cumulative active-energy index.
  if (base !== null) {
    data.metering = { energy: { total: base } };
  } else {
    warnings.push('no cumulative energy index on the TIC bus (BASE absent)');
  }

  // Whole-meter power registers: power.active (W), power.apparent (VA).
  if (pmax !== null) {
    if (!data.power) {
      data.power = {};
    }
    data.power.active = pmax;
  }
  if (papp !== null) {
    if (!data.power) {
      data.power = {};
    }
    data.power.apparent = papp;
  }

  // Genuine whole-meter data the vocabulary does not model -> camelCase extra.
  if (adco.length > 0) {
    data.meterId = adco;
  }

  // One reserved channels[] entry per supply phase, built lazily so a phase the
  // TIC bus did not report (0x80000000 sentinel on both its registers) produces
  // no entry at all.
  var iinst = [iinst1, iinst2, iinst3];
  var imax = [imax1, imax2, imax3];
  var phases = [null, null, null];
  var i;
  for (i = 0; i < 3; i++) {
    if (iinst[i] !== null) {
      if (phases[i] === null) {
        phases[i] = { channel: TIC_TRI_PHASE_LABELS[i] };
      }
      phases[i].power = { current: iinst[i] };
    }
    if (imax[i] !== null) {
      if (phases[i] === null) {
        phases[i] = { channel: TIC_TRI_PHASE_LABELS[i] };
      }
      phases[i].maxCurrent = imax[i];
    }
  }
  var entries = [];
  for (i = 0; i < 3; i++) {
    if (phases[i] !== null) {
      entries.push(phases[i]);
    }
  }
  if (entries.length > 0) {
    data.channels = entries;
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
            ' (Adeunis TIC CBE LINKY TRI frames 0x10, 0x20, 0x30, 0x49, 0x4a are normalized)'
        ]
      };
  }
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "adeunis", model: "tic-cbe-linky-tri" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "tic-cbe-linky-tri";
  }
  return result;
}
