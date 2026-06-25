// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ewattch/tyness (modular LoRaWAN node; the
// power-metering variant carries one or more current clamps).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/ewattch/ewattchlorawandecoder.js,
// attributed in NOTICE). The upstream file is Ewattch's generic decoder shared
// across the whole product line (environnement/presence/ambiance/squid/impulse/
// tyness/tynode). The source of truth for the tyness power-meter wire format is
// its data-frame path:
//   header byte0 = 0  -> data frame (object table); byte1 = payload length
//   each object: low bit = has-socket/channel byte; bit7 = error flag;
//                bits1..6 (mask 0x7e) = object type code
//   the "clamp" object (type code 0x40) is the calibrated power-meter source.
//
// Clamp object layout (faithful port of upstream case 0x40, non-paired branch):
//   measure header byte: high nibble n = channel count, low nibble u = measure
//   code. Per channel, a little-endian integer of width 2 (u in {10,12}) or 3
//   (otherwise), scaled by the per-code factor below. Power (code 4) and
//   reactivePower (code 8) are sign-extended from 24 bits.
//     u=0  currentIndex            x10   mAh
//     u=1  current                 x1    mA
//     u=3  consumedActiveEnergy    x10   Wh   (the cumulative active index)
//     u=4  power (active)          x1    W
//     u=5  producedActiveEnergy    x10   Wh
//     u=6  positiveReactiveEnergy  x10   varh
//     u=7  negativeReactiveEnergy  x10   varh
//     u=8  reactivePower           x1    var
//     u=9  apparentEnergy          x10   VAh
//     u=10 voltage                 x0.1  V    (width 2)
//     u=11 apparentPower           x1    VA
//     u=12 frequency               x0.01 Hz   (width 2)
//   The paired branch (low nibble of header == 2) emits, per channel, a
//   currentIndex block then a current block (both 3-byte LE).
//
// Mapping into the normalized vocabulary (taken from the FIRST clamp channel
// encountered in the frame; this is the device's primary measured circuit):
//   voltage              -> power.voltage           (V; satisfies power-meter)
//   current  (mA)        -> power.current           (A; mA / 1000)
//   power    (W)         -> power.active            (W)
//   consumedActiveEnergy -> metering.energy.total   (Wh; cumulative active index)
//   apparentPower (VA)   -> power.apparent          (VA)
//   frequency (Hz)       -> power.frequency         (Hz)
// Additional clamp quantities the vocabulary does not model become camelCase
// extras (Wh/varh/VAh indexes, reactive power, raw current index):
//   currentIndex            -> currentIndexMah
//   producedActiveEnergy    -> producedActiveEnergyWh
//   positiveReactiveEnergy  -> positiveReactiveEnergyVarh
//   negativeReactiveEnergy  -> negativeReactiveEnergyVarh
//   reactivePower           -> reactivePowerVar
//   apparentEnergy          -> apparentEnergyVah
//   socket/channel of the primary clamp -> socket / channel
//
// Scope note: a single uplink may report several clamp channels and several
// non-clamp objects (analog/pulse/digital/temperature). Those non-clamp
// channels are raw/uncalibrated or out of scope for power-meter and are NOT
// emitted. ChirpStack rejects top-level arrays, so we normalize the primary
// (first) clamp channel rather than emit an array.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(bytes, i) {
  return bytes[i] & 0xff;
}

// Little-endian unsigned, width 2 or 3.
function uleN(bytes, i, width) {
  if (width === 2) {
    return (bytes[i] | (bytes[i + 1] << 8)) >>> 0;
  }
  return (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) >>> 0;
}

// Per-measure-code table for the clamp object: [factor, kind].
// kind selects how the decoded scalar maps into the normalized output.
var CLAMP_CODES = {
  0: [10, 'currentIndexMah'],
  1: [1, 'currentMa'],
  3: [10, 'energyTotalWh'],
  4: [1, 'activeW'],
  5: [10, 'producedActiveEnergyWh'],
  6: [10, 'positiveReactiveEnergyVarh'],
  7: [10, 'negativeReactiveEnergyVarh'],
  8: [1, 'reactivePowerVar'],
  9: [10, 'apparentEnergyVah'],
  10: [0.1, 'voltageV'],
  11: [1, 'apparentVa'],
  12: [0.01, 'frequencyHz']
};

// Decode one clamp object starting at the measure-header byte index `mh`.
// Records only the FIRST channel's scalar for each kind into `acc`, and
// returns the index just past the object's data.
function decodeClamp(bytes, mh, acc) {
  var header = u8(bytes, mh);
  var n = (header & 0xf0) >> 4;
  var u = header & 0x0f;
  var i = mh + 1;
  var c;

  if (u === 2) {
    // Paired branch: n currentIndex blocks (3-byte LE, x10 mAh) then n current
    // blocks (3-byte LE, x1 mA). Capture channel 0 of each.
    for (c = 0; c < n; c++) {
      if (c === 0 && acc.currentIndexMah === undefined) {
        acc.currentIndexMah = 10 * uleN(bytes, i, 3);
      }
      i += 3;
    }
    for (c = 0; c < n; c++) {
      if (c === 0 && acc.currentMa === undefined) {
        acc.currentMa = uleN(bytes, i, 3);
      }
      i += 3;
    }
    return i;
  }

  var spec = CLAMP_CODES[u];
  if (!spec) {
    // Unknown clamp measure code: upstream returns a string and stops; we
    // signal the caller to abort with an error.
    acc.badClampCode = u;
    return -1;
  }

  var width = (u === 10 || u === 12) ? 2 : 3;
  var kind = spec[1];
  var factor = spec[0];

  for (c = 0; c < n; c++) {
    var raw = uleN(bytes, i, width);
    // Power (4) and reactivePower (8) are signed 24-bit.
    if ((u === 4 || u === 8) && (raw & 0x800000)) {
      raw = raw - 0x1000000;
    }
    if (c === 0 && acc[kind] === undefined) {
      acc[kind] = raw * factor;
    }
    i += width;
  }
  return i;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  // Header. byte0 == 0 selects the data-frame object table; any other value is
  // a config/info frame that carries no power-meter measurement.
  if ((bytes[0] & 0xff) !== 0) {
    return { errors: ['not a data frame (header byte 0x' + (bytes[0] & 0xff).toString(16) + '): no power-meter measurement'] };
  }
  if (bytes[1] !== bytes.length - 2) {
    return { errors: ['Payload size indicated does not match payload size given'] };
  }

  var acc = {};
  var sawClamp = false;
  var i = 2;

  while (i < bytes.length) {
    var head = u8(bytes, i);
    var hasAddr = (head & 0x01) === 1;
    var isError = (head & 0x80) === 0x80;
    var typeCode = head & 0x7e;
    i += 1;

    if (typeCode !== 0x40) {
      // Non-clamp object types are out of scope for power-meter. Without a
      // full length table for every object we cannot safely skip past them,
      // so abort rather than misalign the stream.
      return { errors: ['unsupported object type 0x' + typeCode.toString(16) + ': no clamp/power-meter data'] };
    }

    var socket = 0;
    var channel = 0;
    if (hasAddr) {
      var addr = u8(bytes, i);
      socket = (addr & 0xe0) >> 5;
      channel = addr & 0x1f;
      i += 1;
    }

    if (isError) {
      // Clamp object flagged in error: 1 status byte, no measurement.
      i += 1;
      if (!sawClamp && acc.socket === undefined) {
        acc.socket = socket;
        acc.channel = channel;
      }
      continue;
    }

    if (acc.socket === undefined) {
      acc.socket = socket;
      acc.channel = channel;
    }
    var next = decodeClamp(bytes, i, acc);
    if (next < 0) {
      return { errors: ['unknown clamp measure code ' + acc.badClampCode] };
    }
    i = next;
    sawClamp = true;
  }

  if (!sawClamp) {
    return { errors: ['no clamp measurement in frame'] };
  }

  var haveVocab = acc.voltageV !== undefined ||
    acc.currentMa !== undefined ||
    acc.activeW !== undefined ||
    acc.energyTotalWh !== undefined ||
    acc.apparentVa !== undefined ||
    acc.frequencyHz !== undefined;
  if (!haveVocab && acc.currentIndexMah === undefined &&
      acc.reactivePowerVar === undefined && acc.apparentEnergyVah === undefined &&
      acc.producedActiveEnergyWh === undefined &&
      acc.positiveReactiveEnergyVarh === undefined &&
      acc.negativeReactiveEnergyVarh === undefined) {
    return { errors: ['clamp object carried no measurement value'] };
  }

  var data = {};
  var power = {};

  if (acc.voltageV !== undefined) {
    power.voltage = round(acc.voltageV, 1);
  }
  if (acc.currentMa !== undefined) {
    power.current = round(acc.currentMa / 1000, 3);
  }
  if (acc.activeW !== undefined) {
    power.active = round(acc.activeW, 0);
  }
  if (acc.apparentVa !== undefined) {
    power.apparent = round(acc.apparentVa, 0);
  }
  if (acc.frequencyHz !== undefined) {
    power.frequency = round(acc.frequencyHz, 2);
  }

  var hasPower = false;
  var k;
  for (k in power) {
    if (power.hasOwnProperty(k)) {
      hasPower = true;
    }
  }
  if (hasPower) {
    data.power = power;
  }

  if (acc.energyTotalWh !== undefined) {
    data.metering = { energy: { total: round(acc.energyTotalWh, 0) } };
  }

  // Extras: quantities the vocabulary does not model.
  if (acc.currentIndexMah !== undefined) {
    data.currentIndexMah = round(acc.currentIndexMah, 0);
  }
  if (acc.producedActiveEnergyWh !== undefined) {
    data.producedActiveEnergyWh = round(acc.producedActiveEnergyWh, 0);
  }
  if (acc.positiveReactiveEnergyVarh !== undefined) {
    data.positiveReactiveEnergyVarh = round(acc.positiveReactiveEnergyVarh, 0);
  }
  if (acc.negativeReactiveEnergyVarh !== undefined) {
    data.negativeReactiveEnergyVarh = round(acc.negativeReactiveEnergyVarh, 0);
  }
  if (acc.reactivePowerVar !== undefined) {
    data.reactivePowerVar = round(acc.reactivePowerVar, 0);
  }
  if (acc.apparentEnergyVah !== undefined) {
    data.apparentEnergyVah = round(acc.apparentEnergyVah, 0);
  }

  data.socket = acc.socket;
  data.channel = acc.channel;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "ewattch";
    result.data.model = "tyness";
  }
  return result;
}
