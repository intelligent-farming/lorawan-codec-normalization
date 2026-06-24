// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for keller/adt1-tube (Keller ADT1 tube:
// groundwater pressure & level data logger).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/keller/kellerpayload.js, codecId
// "keller-codec", attributed in NOTICE). The wire format and channel maps are
// faithful to upstream; normalization to the shared vocabulary is authored here
// (we do NOT reuse upstream's output shape).
//
// Wire format (see https://docs.pressuresuite.com/sending-technology/lora-technology/keller-lora-payload/):
//   bytes[0] = function code: 1 = measurement package, 12 = device-info package.
//   Measurement package:
//     bytes[1]   = ct (device/connection type) -> selects a channel-name list.
//     bytes[2..3]= 16-bit channel bitmask (big-endian). Each set bit, counted
//                  from the LSB, selects the channel name at that index in the
//                  ct list. Channels appear in the payload in ascending bit
//                  order, 4 bytes each, IEEE-754 big-endian float.
//   Info package: battery voltage (float bytes 14..17), capacity % (18),
//                 enclosure humidity % (19), plus version/serial/datetime.
//
// Canonical mapping:
//   P1 (medium/hydrostatic pressure, bar) -> water.pressure (kPa, bar*100)
//   mH2O water-column level (m)           -> water.level (m)
//   TOB1/TOB2/T (medium/water temp, C)    -> water.temperature.current (C)
//   Conductivity Tc/raw (mS/cm)           -> water.ec (uS/cm, mS/cm*1000)
//   info battery_voltage (V)              -> battery
//   PBaro (atmospheric, bar)              -> extra barometricPressureKpa
//   TBaro (barometer electronics temp)    -> extra barometerTemperature
//   battery_capacity_percentage           -> extra batteryPercent
//   humidity_percentage (enclosure)       -> extra enclosureHumidity
//   everything else                       -> camelCase extras

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  var func = bytes[0];

  if (func === 1) {
    return decodeMeasurement(bytes);
  }
  if (func === 12) {
    return decodeInfo(bytes);
  }
  return { errors: ['unsupported function code ' + func] };
}

function decodeMeasurement(bytes) {
  if (bytes.length < 4) {
    return { errors: ['measurement package too short'] };
  }
  var ct = bytes[1];
  var names = DEVICE_TYPE_CHANNELS[ct];
  if (!names) {
    return { errors: ['unsupported device type ' + ct] };
  }

  var mask = byteToBits(bytes[2]) + byteToBits(bytes[3]);
  var reverted = reverseString(mask);

  var data = {};
  // Collect a chosen water temperature with precedence T > TOB1 > TOB2.
  var waterTempRank = 0; // 0 none, 1 TOB2, 2 TOB1, 3 T
  // Track conductivity: prefer temperature-compensated ("Tc") over raw for water.ec.
  var ecIsTc = false;
  var ecSet = false;

  var channelIndex = 0;
  for (var bit = 0; bit < reverted.length; bit++) {
    if (reverted.charAt(bit) !== '1') {
      continue;
    }
    var name = names[bit];
    var offset = 4 + channelIndex * 4;
    channelIndex++;
    if (offset + 4 > bytes.length) {
      return { errors: ['truncated channel data'] };
    }
    var value = bytesToFloat(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    if (typeof name !== 'string') {
      data['channelBit' + bit] = round(value, 6);
      continue;
    }

    if (name === 'P1') {
      data.water = data.water || {};
      data.water.pressure = round(value * 100, 3);
    } else if (name === 'PBaro') {
      data.barometricPressureKpa = round(value * 100, 3);
    } else if (name === 'P2') {
      data.pressureP2Kpa = round(value * 100, 3);
    } else if (name.indexOf('Pd ') === 0) {
      data.differentialPressureKpa = round(value * 100, 3);
    } else if (name.indexOf('P1 (') === 0) {
      data[camel(name)] = round(value * 100, 3);
    } else if (name.indexOf('mH20') === 0) {
      data.water = data.water || {};
      data.water.level = round(value, 4);
    } else if (name === 'T' || name === 'TOB1' || name === 'TOB2') {
      var rank = (name === 'T') ? 3 : (name === 'TOB1') ? 2 : 1;
      if (rank > waterTempRank) {
        data.water = data.water || {};
        data.water.temperature = data.water.temperature || {};
        data.water.temperature.current = round(value, 2);
        waterTempRank = rank;
      } else {
        data[(name === 'TOB1') ? 'tob1Temperature' : 'tob2Temperature'] = round(value, 2);
      }
    } else if (name === 'TBaro') {
      data.barometerTemperature = round(value, 2);
    } else if (name.indexOf('Conductivity Tc') === 0 || name.indexOf('Conductivity raw') === 0) {
      var isTc = name.indexOf('Conductivity Tc') === 0;
      var us = round(value * 1000, 1);
      if (!ecSet) {
        data.water = data.water || {};
        data.water.ec = us;
        ecSet = true;
        ecIsTc = isTc;
      } else if (isTc && !ecIsTc) {
        // A temperature-compensated reading supersedes a previously stored raw one.
        data.conductivityRawUsPerCm = data.water.ec;
        data.water.ec = us;
        ecIsTc = true;
      } else {
        data[isTc ? 'conductivityTcUsPerCm' : 'conductivityRawUsPerCm'] = us;
      }
    } else if (name.indexOf('T (Conductivity)') === 0) {
      data.conductivityTemperature = round(value, 2);
    } else {
      data[camel(name)] = round(value, 6);
    }
  }

  if (channelIndex === 0) {
    return { errors: ['no channels set in bitmask'] };
  }
  return { data: data };
}

function decodeInfo(bytes) {
  if (bytes.length < 20) {
    return { errors: ['info package too short'] };
  }
  var data = {
    battery: round(bytesToFloat(bytes[14], bytes[15], bytes[16], bytes[17]), 3),
    batteryPercent: bytes[18],
    enclosureHumidity: bytes[19],
    classGroup: pad(bytes[2], 2) + '.' + pad(bytes[3], 2),
    swVersion: pad(bytes[4], 2) + '.' + pad(bytes[5], 2),
    serialNumber: bytesToInt(bytes[6], bytes[7], bytes[8], bytes[9]),
    deviceLocalDatetime: bytesToDatetime(bytes[10], bytes[11], bytes[12], bytes[13])
  };
  return { data: data };
}

// IEEE-754 single-precision, most-significant byte first.
function bytesToFloat(b0, b1, b2, b3) {
  var bits = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
  var sign = (bits >>> 31 === 0) ? 1.0 : -1.0;
  var e = (bits >>> 23) & 0xff;
  var m = (e === 0) ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * m * Math.pow(2, e - 150);
}

function bytesToInt(b0, b1, b2, b3) {
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

// Seconds since 2000-01-01T00:00:00Z -> device-local datetime string.
function bytesToDatetime(b0, b1, b2, b3) {
  var zero = Date.UTC(2000, 0, 1, 0, 0, 0);
  var secs = bytesToInt(b0, b1, b2, b3);
  var d = new Date(zero + secs * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) +
    ' ' + pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2);
}

function byteToBits(b) {
  var s = (b & 0xff).toString(2);
  while (s.length < 8) {
    s = '0' + s;
  }
  return s;
}

function reverseString(s) {
  return s.split('').reverse().join('');
}

function camel(name) {
  var cleaned = name.replace(/[()]/g, ' ').replace(/[^A-Za-z0-9]+/g, ' ').trim();
  var parts = cleaned.split(' ');
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) {
      continue;
    }
    if (out === '') {
      out = p.charAt(0).toLowerCase() + p.slice(1);
    } else {
      out = out + p.charAt(0).toUpperCase() + p.slice(1);
    }
  }
  return out;
}

function pad(num, size) {
  var s = num.toString();
  while (s.length < size) {
    s = '0' + s;
  }
  return s;
}

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Device type -> ordered channel-name list (faithful to upstream kellerpayload.js).
var DEVICE_TYPE_CHANNELS = {
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "keller";
    result.data.model = "adt1-tube";
  }
  return result;
}
