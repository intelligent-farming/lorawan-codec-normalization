// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for keller/adt1-box (KELLER ADT1 box — groundwater
// pressure & level data logger). Shares the KELLER LoRa payload protocol with
// keller/adt1-tube (same "keller-codec" family).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/keller/kellerpayload.js, derived from
// github.com/KELLERAGfuerDruckmesstechnik/KellerAgTheThingsNetworkPayloadDecoder,
// attributed in NOTICE). Wire format documented at docs.pressuresuite.com. The
// normalization below is authored here; the upstream normalizeUplink is NOT copied.
//
// Function code 1 = measurement package; function code 12 = device-information
// package. Measurement channels map to a device-type-specific channel layout.
// KELLER reports pressures in bar, temperatures in °C, conductivity in mS/cm; we
// normalize to the shared vocabulary (water.pressure kPa, water.level m,
// water.temperature.current °C, water.ec µS/cm, battery V).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// MSB-first IEEE-754 single-precision float from 4 bytes.
function bytesToFloat(b) {
  var bits = b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3];
  var sign = (bits >>> 31 === 0) ? 1.0 : -1.0;
  var e = bits >>> 23 & 0xff;
  var mant = (e === 0) ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * mant * Math.pow(2, e - 150);
}

function bytesToBinaryString(bytes) {
  var binary = '';
  for (var i = 0, l = bytes.length; i < l; i++) {
    var bits = bytes[i].toString(2);
    while (bits.length < 8) {
      bits = '0' + bits;
    }
    binary = binary + bits;
  }
  return binary;
}

function bytesToInt(bytes) {
  var binaryString = bytesToBinaryString(bytes);
  if (binaryString.length === 0) {
    return 0;
  }
  return parseInt(binaryString, 2);
}

function pad(num, size) {
  var s = num.toString();
  while (s.length < size) {
    s = '0' + s;
  }
  return s;
}

// Seconds since 2000-01-01T00:00:00Z -> RFC3339 string.
function bytesToDate(bytes) {
  var zero = new Date('2000-01-01T00:00:00.000Z').getTime();
  var date = new Date(zero + bytesToInt(bytes) * 1000);
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1, 2) + '-' +
    pad(date.getUTCDate(), 2) + 'T' + pad(date.getUTCHours(), 2) + ':' +
    pad(date.getUTCMinutes(), 2) + ':' + pad(date.getUTCSeconds(), 2) + 'Z';
}

// KELLER channel id -> human-readable name (from the upstream protocol map).
var CHANNEL = {
  1: 'Pd (P1-P2)', 2: 'P1', 3: 'P2', 4: 'T', 5: 'TOB1', 6: 'TOB2',
  7: 'PBaro', 8: 'TBaro', 9: 'Volt Inp. 1', 10: 'Volt Inp. 2',
  11: 'Pd (P1-PBaro)', 12: 'Conductivity Tc', 13: 'Conductivity raw',
  14: 'T (Conductivity)', 15: 'P1 (2)', 16: 'P1 (3)', 17: 'P1 (4)',
  18: 'P1 (5)', 19: 'Counter input', 20: 'SDI12 CH1', 21: 'SDI12 CH2',
  22: 'SDI12 CH3', 23: 'SDI12 CH4', 24: 'SDI12 CH5', 25: 'SDI12 CH6',
  26: 'SDI12 CH7', 27: 'SDI12 CH8', 28: 'SDI12 CH9', 29: 'SDI12 CH10',
  30: 'TOB1 (2)', 31: 'TOB1 (3)', 32: 'TOB1 (4)', 33: 'TOB1 (5)',
  34: 'E', 35: 'F', 36: 'G', 37: 'mH2O (PBaro)', 38: 'mH2O (P1-P2)',
  39: 'mH2O (P1-P3)', 40: 'mH2O (P1-P4)', 41: 'mH2O (P1-P5)',
  42: 'Conductivity Tc (2)', 43: 'Conductivity Tc (3)',
  44: 'T (Conductivity) (2)', 45: 'T (Conductivity) (3)', 46: 'P2 (2)',
  47: 'TOB2 (2)', 48: 'AquaMaster Flow Rate', 49: 'AquaMaster Pressure',
  50: 'AquaMaster Custom Flow Units', 51: 'AquaMaster External Supply Voltage',
  52: 'Tank Content 1', 53: 'Tank Content 2', 54: 'Tank Content 3'
};

function m(id) {
  return CHANNEL[id];
}

// Per device-type (ct) ordered channel layout (from the upstream protocol).
var DEVICE_TYPE_CHANNELS = {
  0: [m(1), m(2), m(3), m(4), m(5), m(6)],
  1: [m(1), m(2), m(3), m(4), m(5), m(6)],
  2: [m(11), m(2), m(3), m(4), m(5), m(6), m(7), m(8)],
  3: [m(11), m(2), m(3), m(4), m(5), m(6), m(7), m(8)],
  4: [m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(8), m(9), m(10)],
  5: [m(11), m(2), m(3), m(4), m(5), m(6), m(7), m(8), m(9), m(10), m(11)],
  6: [m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(8), m(9), m(10), m(15), m(16), m(17), m(18), m(19)],
  7: [m(7), m(8), m(9), m(10), m(20), m(21), m(22), m(23), m(24), m(25), m(26), m(27), m(28), m(29)],
  8: [m(2), m(5), m(15), m(30), m(16), m(31), m(17), m(32), m(18), m(33), m(9), m(10), m(7), m(8), m(19)],
  9: [m(1), m(2), m(3), m(14), m(5), m(6), m(7), m(8), m(9), m(10), m(12), m(13)],
  10: [m(11), m(2), m(3), m(14), m(5), m(6), m(7), m(8), m(9), m(10), m(12), m(13)],
  11: [m(2), m(5), m(12), m(14), m(15), m(30), m(42), m(44), m(16), m(31), m(43), m(45), m(7), m(8), m(19)],
  13: [m(2), m(3), m(5), m(6), m(15), m(46), m(30), m(47), m(7), m(8), m(9), m(10), m(19)]
};

// Turn a KELLER channel name into a stable camelCase extra key.
function toCamelExtra(name) {
  var cleaned = name.replace(/[()]/g, ' ').replace(/-/g, ' ');
  var parts = cleaned.split(/\s+/);
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.length === 0) {
      continue;
    }
    if (out.length === 0) {
      out += p.charAt(0).toLowerCase() + p.slice(1);
    } else {
      out += p.charAt(0).toUpperCase() + p.slice(1);
    }
  }
  return out;
}

// Map raw channel readings (KELLER units) into the normalized measurement.
function mapMeasurements(readings, data, extras) {
  for (var name in readings) {
    if (!Object.prototype.hasOwnProperty.call(readings, name)) {
      continue;
    }
    var v = readings[name];
    if (name === 'P1') {
      // Medium (water-column) pressure, bar -> water.pressure kPa.
      data.water.pressure = round(v * 100, 3);
    } else if (name === 'PBaro') {
      // Barometric reference, bar -> extra kPa.
      extras.barometricPressureKpa = round(v * 100, 3);
    } else if (name === 'mH2O (PBaro)' || name === 'mH2O (P1-P2)' ||
               name === 'mH2O (P1-P3)' || name === 'mH2O (P1-P4)' ||
               name === 'mH2O (P1-P5)') {
      // Water-column level, metres of water column -> water.level m.
      data.water.level = round(v, 3);
    } else if (name === 'T' || name === 'TOB1' || name === 'TOB2') {
      // Medium / sensor-on-board temperature, °C -> water.temperature.current.
      // First wins; TOB1 is the primary medium temperature.
      if (data.water.temperature.current === undefined) {
        data.water.temperature.current = round(v, 2);
      }
    } else if (name === 'TBaro') {
      extras.barometerTemperature = round(v, 2);
    } else if (name === 'Conductivity Tc' || name === 'Conductivity raw') {
      // Conductivity, mS/cm -> water.ec µS/cm. First wins.
      if (data.water.ec === undefined) {
        data.water.ec = round(v * 1000, 1);
      }
    } else {
      // Anything else (differential pressures, voltage inputs, SDI-12, tanks,
      // counters) becomes a camelCase extra carrying the raw KELLER value.
      extras[toCamelExtra(name)] = round(v, 4);
    }
  }
}

function decodeUplink(input) {
  if (!input || !input.bytes || input.bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  var bytes = input.bytes;
  var func = bytes[0];

  if (func === 12) {
    // Device information package.
    if (bytes.length < 20) {
      return { errors: ['information package too short'] };
    }
    var info = {};
    info.battery = round(bytesToFloat(bytes.slice(14, 18)), 3);
    info.batteryPercent = bytes[18];
    info.enclosureHumidity = bytes[19];
    info.classGroup = pad(bytes[2], 2) + '.' + pad(bytes[3], 2);
    info.swVersion = pad(bytes[4], 2) + '.' + pad(bytes[5], 2);
    info.serialNumber = bytesToInt(bytes.slice(6, 10));
    info.deviceLocalDatetime = bytesToDate(bytes.slice(10, 14));
    return { data: info };
  }

  if (func === 1) {
    // Measurement package.
    if (bytes.length < 4) {
      return { errors: ['measurement package too short'] };
    }
    var ct = bytes[1];
    var layout = DEVICE_TYPE_CHANNELS[ct];
    if (!layout) {
      return { errors: ['unsupported device type (ct) ' + ct] };
    }
    var channel = bytesToBinaryString(bytes.slice(2, 4));
    var ones = channel.match(/1/g);
    var channelCount = ones ? ones.length : 0;
    var channelsReverted = channel.split('').reverse().join('');
    var idx = channelsReverted.indexOf('1');

    var readings = {};
    for (var i = 1; i <= channelCount; i++) {
      var msbIndex = i * 4;
      if (msbIndex + 4 > bytes.length) {
        return { errors: ['measurement package truncated'] };
      }
      var name = layout[idx];
      if (name !== undefined) {
        readings[name] = bytesToFloat(bytes.slice(msbIndex, msbIndex + 4));
      }
      idx = channelsReverted.indexOf('1', idx + 1);
    }

    var mdata = { water: { temperature: {} } };
    var mextras = {};
    mapMeasurements(readings, mdata, mextras);

    // Drop the temperature container if no temperature channel was present.
    var hasTemp = false;
    for (var tk in mdata.water.temperature) {
      if (Object.prototype.hasOwnProperty.call(mdata.water.temperature, tk)) {
        hasTemp = true;
      }
    }
    if (!hasTemp) {
      delete mdata.water.temperature;
    }

    for (var x in mextras) {
      if (Object.prototype.hasOwnProperty.call(mextras, x)) {
        mdata[x] = mextras[x];
      }
    }

    if (mdata.water.level === undefined && mdata.water.pressure === undefined) {
      return { errors: ['no water level or pressure channel in payload'] };
    }
    return { data: mdata };
  }

  return { errors: ['unsupported function code ' + func] };
}
