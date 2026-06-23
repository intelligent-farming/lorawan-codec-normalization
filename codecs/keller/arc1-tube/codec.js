// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for keller/arc1-tube (KELLER ARC1 tube — groundwater
// pressure & level data logger). Emits the shared `groundwater` vocabulary.
//
// Wire format ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/keller/kellerpayload.js, attributed
// in NOTICE). The KELLER shared "keller-codec" is used across the ADT1/ARC1
// family. The byte-walk (function code, connection-type channel table, MSB-first
// IEEE-754 floats) is re-authored here; the normalization is ours and maps to
// canonical units — we do NOT copy upstream normalizeUplink.
//
// Ported-from: KellerAgTheThingsNetworkPayloadDecoder kellerpayload.js
// (https://github.com/KELLERAGfuerDruckmesstechnik/KellerAgTheThingsNetworkPayloadDecoder)
//
// Canonical unit mapping:
//   medium pressure P1 (bar)         -> water.pressure (kPa, x100)
//   barometric PBaro (bar)           -> extra barometricPressureKpa (x100)
//   level mH2O                        -> water.level (m)        [no ct emits it]
//   medium/water temp T/TOB1/TOB2    -> water.temperature.current (degC)
//   barometer temp TBaro             -> extra barometerTemperature (degC)
//   conductivity (mS/cm)             -> water.ec (uS/cm, x1000)
//   info battery_voltage             -> battery (V)
//   info battery_capacity_percentage -> extra batteryPercent
//   info humidity_percentage         -> extra enclosureHumidity
//   anything else                    -> camelCase extra

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  var func = bytes[0];

  if (func === 12) {
    return decodeInformation(bytes);
  }
  if (func === 1) {
    return decodeMeasurements(bytes);
  }
  return { errors: ['unsupported function code: ' + func] };
}

// ---- function code 1: measurement package ----------------------------------

function decodeMeasurements(bytes) {
  var ct = bytes[1];
  var names = CHANNEL_TABLE[ct];
  if (!names) {
    return { errors: ['unsupported connection type: ' + ct] };
  }

  var mask = bytesToBinaryString(bytes.slice(2, 4));
  var reverted = mask.split('').reverse().join('');
  var channelCount = 0;
  var m;
  for (m = 0; m < reverted.length; m++) {
    if (reverted.charAt(m) === '1') { channelCount++; }
  }
  if (channelCount === 0) {
    return { errors: ['no channels set in measurement package'] };
  }

  var data = {};
  var bestTemp = null; // priority: T > TOB1 > TOB2
  var idx = reverted.indexOf('1');
  var i;
  for (i = 1; i <= channelCount; i++) {
    var msb = i * 4;
    var slice = bytes.slice(msb, msb + 4);
    if (slice.length < 4) {
      return { errors: ['truncated measurement channel ' + i] };
    }
    var name = names[idx];
    var value = bytesToFloat(slice);

    if (name === 'P1') {
      data.water = data.water || {};
      data.water.pressure = round(value * 100, 2);
    } else if (name === 'PBaro') {
      data.barometricPressureKpa = round(value * 100, 2);
    } else if (name === 'TBaro') {
      data.barometerTemperature = round(value, 2);
    } else if (name === 'T' || name === 'TOB1' || name === 'TOB2') {
      var rank = (name === 'T') ? 3 : (name === 'TOB1') ? 2 : 1;
      if (bestTemp === null || rank > bestTemp.rank) {
        bestTemp = { rank: rank, value: round(value, 2) };
      }
    } else if (name === 'Conductivity Tc' || name === 'Conductivity raw') {
      data.water = data.water || {};
      data.water.ec = round(value * 1000, 1);
    } else if (startsWith(name, 'mH20') || startsWith(name, 'mH2O')) {
      data.water = data.water || {};
      data.water.level = round(value, 3);
    } else {
      data[extraKey(name)] = round(value, 4);
    }

    idx = reverted.indexOf('1', idx + 1);
  }

  if (bestTemp !== null) {
    data.water = data.water || {};
    data.water.temperature = { current: bestTemp.value };
  }

  if (!data.water || (data.water.level === undefined && data.water.pressure === undefined)) {
    return { errors: ['no water level or pressure channel in payload'] };
  }
  return { data: data };
}

// ---- function code 12: device information package --------------------------

function decodeInformation(bytes) {
  if (bytes.length < 20) {
    return { errors: ['truncated information package'] };
  }
  var data = {};
  data.battery = round(bytesToFloat(bytes.slice(14, 18)), 3);
  data.batteryPercent = bytes[18];
  data.enclosureHumidity = bytes[19];
  data.classGroup = pad(bytes[2], 2) + '.' + pad(bytes[3], 2);
  data.swVersion = pad(bytes[4], 2) + '.' + pad(bytes[5], 2);
  data.serialNumber = bytesToInt(bytes.slice(6, 10));
  return { data: data };
}

// ---- helpers ----------------------------------------------------------------

// MSB-first IEEE-754 single-precision float from 4 bytes.
function bytesToFloat(b) {
  var bits = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
  var sign = (bits >>> 31 === 0) ? 1.0 : -1.0;
  var e = (bits >>> 23) & 0xff;
  var mant = (e === 0) ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * mant * Math.pow(2, e - 150);
}

function bytesToBinaryString(b) {
  var out = '';
  var i;
  for (i = 0; i < b.length; i++) {
    var bits = b[i].toString(2);
    while (bits.length < 8) { bits = '0' + bits; }
    out = out + bits;
  }
  return out;
}

function bytesToInt(b) {
  var s = bytesToBinaryString(b);
  if (s.length === 0) { return 0; }
  return parseInt(s, 2);
}

function pad(num, size) {
  var s = num.toString();
  while (s.length < size) { s = '0' + s; }
  return s;
}

function startsWith(s, prefix) {
  return s.length >= prefix.length && s.substring(0, prefix.length) === prefix;
}

// Turn an upstream channel label into a safe camelCase extra key.
function extraKey(name) {
  var cleaned = name.replace(/[^A-Za-z0-9]+/g, ' ');
  var parts = cleaned.split(' ');
  var out = '';
  var i;
  for (i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.length === 0) { continue; }
    if (out.length === 0) {
      out = p.charAt(0).toLowerCase() + p.substring(1);
    } else {
      out = out + p.charAt(0).toUpperCase() + p.substring(1);
    }
  }
  if (out.length === 0) { out = 'channel'; }
  return out;
}

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Connection-type -> ordered channel-name table (KELLER protocol).
var CHANNEL_TABLE = {
  0: ['Pd (P1-P2)', 'P1', 'P2', 'T', 'TOB1', 'TOB2'],
  1: ['Pd (P1-P2)', 'P1', 'P2', 'T', 'TOB1', 'TOB2'],
  2: ['Pd (P1-PBaro)', 'P1', 'P2', 'T', 'TOB1', 'TOB2', 'PBaro', 'TBaro'],
  3: ['Pd (P1-PBaro)', 'P1', 'P2', 'T', 'TOB1', 'TOB2', 'PBaro', 'TBaro'],
  4: ['Pd (P1-P2)', 'P1', 'P2', 'T', 'TOB1', 'TOB2', 'PBaro', 'TBaro', 'Volt Inp. 1', 'Volt Inp. 2'],
  5: ['Pd (P1-PBaro)', 'P1', 'P2', 'T', 'TOB1', 'TOB2', 'PBaro', 'TBaro', 'Volt Inp. 1', 'Volt Inp. 2', 'Pd (P1-PBaro)'],
  6: ['Pd (P1-P2)', 'P1', 'P2', 'T', 'TOB1', 'TOB2', 'PBaro', 'TBaro', 'Volt Inp. 1', 'Volt Inp. 2', 'P1 (2)', 'P1 (3)', 'P1 (4)', 'P1 (5)', 'Counter input'],
  7: ['PBaro', 'TBaro', 'Volt Inp. 1', 'Volt Inp. 2', 'SDI12 CH1', 'SDI12 CH2', 'SDI12 CH3', 'SDI12 CH4', 'SDI12 CH5', 'SDI12 CH6', 'SDI12 CH7', 'SDI12 CH8', 'SDI12 CH9', 'SDI12 CH10'],
  8: ['P1', 'TOB1', 'P1 (2)', 'TOB1 (2)', 'P1 (3)', 'TOB1 (3)', 'P1 (4)', 'TOB1 (4)', 'P1 (5)', 'TOB1 (5)', 'Volt Inp. 1', 'Volt Inp. 2', 'PBaro', 'TBaro', 'Counter input'],
  9: ['Pd (P1-P2)', 'P1', 'P2', 'T (Conductivity)', 'TOB1', 'TOB2', 'PBaro', 'TBaro', 'Volt Inp. 1', 'Volt Inp. 2', 'Conductivity Tc', 'Conductivity raw'],
  10: ['Pd (P1-PBaro)', 'P1', 'P2', 'T (Conductivity)', 'TOB1', 'TOB2', 'PBaro', 'TBaro', 'Volt Inp. 1', 'Volt Inp. 2', 'Conductivity Tc', 'Conductivity raw'],
  11: ['P1', 'TOB1', 'Conductivity Tc', 'T (Conductivity)', 'P1 (2)', 'TOB1 (2)', 'Conductivity Tc (2)', 'T (Conductivity) (2)', 'P1 (3)', 'TOB1 (3)', 'Conductivity Tc (3)', 'T (Conductivity) (3)', 'PBaro', 'TBaro', 'Counter input'],
  13: ['P1', 'P2', 'TOB1', 'TOB2', 'P1 (2)', 'P2 (2)', 'TOB1 (2)', 'TOB2 (2)', 'PBaro', 'TBaro', 'Volt Inp. 1', 'Volt Inp. 2', 'Counter input']
};
