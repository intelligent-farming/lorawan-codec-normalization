// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for keller/arc1-box
// (KELLER ARC1 Box - Remote Transmitter: groundwater pressure & level
// data logger; shares the KELLER LoRa "keller-codec" payload family).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/keller/kellerpayload.js, attributed
// in NOTICE). Ported from that decoder; do NOT copy upstream normalizeUplink as
// our output.
//
// Wire format (ported faithfully from the upstream KELLER decoder):
//   byte 0 = functionCode.
//   functionCode 1 -> measurement telegram:
//     byte 1        : ct (connection / device type)
//     bytes 2..3    : 16-bit channel bitmask (MSB first). Each set bit, scanned
//                     LSB-first, selects the next channel name from
//                     CHANNEL_NAMES[ct]; channelCount = number of set bits.
//     bytes 4..     : channelCount groups of 4 bytes, each a big-endian IEEE-754
//                     float (bytesToFloat), one per selected channel in order.
//   functionCode 12 -> device information telegram:
//     bytes 14..17  : battery voltage, big-endian float (V)
//     byte 18       : battery capacity (%)
//     byte 19       : enclosure humidity (%)
//     bytes 2..3    : class.group, bytes 4..5 : sw version,
//     bytes 6..9    : serial number, bytes 10..13 : device datetime
//                     (seconds since 2000-01-01Z).
//   any other functionCode is unsupported.
//
// Normalization to canonical vocabulary units:
//   KELLER pressures are reported in bar. medium pressure P1 -> water.pressure
//   in kPa (bar x 100). Barometric PBaro -> extra barometricPressureKpa (bar
//   x 100). Level channels "mH20 (...)" are metres of water column -> water.level
//   (m, unchanged). Medium/water temperatures (T, TOB1, TOB2, T(Conductivity))
//   -> water.temperature.current (degC). Barometer temperature TBaro -> extra
//   barometerTemperature (degC). Conductivity (reported mS/cm) -> water.ec in
//   uS/cm (mS/cm x 1000). Other channels (P2, P3, differential Pd, voltage
//   inputs, counters, SDI-12, AquaMaster, tank, etc.) carry no canonical key
//   and are emitted as camelCase extras under "channels".
//   On the info telegram: battery_voltage -> battery (V); capacity% ->
//   batteryPercent; enclosure humidity -> enclosureHumidity; the remaining
//   identity fields are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian IEEE-754 single-precision float, ported from upstream bytesToFloat.
function bytesToFloat(b) {
  var bits = b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3];
  var sign = (bits >>> 31 === 0) ? 1.0 : -1.0;
  var e = bits >>> 23 & 0xff;
  var m = (e === 0) ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * m * Math.pow(2, e - 150);
}

function bytesToBinaryString(b) {
  var binary = '';
  for (var i = 0; i < b.length; i++) {
    var bits = b[i].toString(2);
    while (bits.length < 8) { bits = '0' + bits; }
    binary = binary + bits;
  }
  return binary;
}

function bytesToInt(b) {
  var s = bytesToBinaryString(b);
  if (s.length === 0) { return 0; }
  return parseInt(s, 2);
}

function pad2(n) {
  var s = n.toString();
  while (s.length < 2) { s = '0' + s; }
  return s;
}

function bytesToDate(b) {
  var zero = new Date('2000-01-01T00:00:00.000Z').getTime();
  var date = new Date(zero + bytesToInt(b) * 1000);
  return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' +
    pad2(date.getUTCDate()) + 'T' + pad2(date.getUTCHours()) + ':' +
    pad2(date.getUTCMinutes()) + ':' + pad2(date.getUTCSeconds()) + 'Z';
}

// Channel-name table (verbatim from upstream `map`).
var MAP = {
  1: 'Pd (P1-P2)', 2: 'P1', 3: 'P2', 4: 'T', 5: 'TOB1', 6: 'TOB2', 7: 'PBaro',
  8: 'TBaro', 9: 'Volt Inp. 1', 10: 'Volt Inp. 2', 11: 'Pd (P1-PBaro)',
  12: 'Conductivity Tc', 13: 'Conductivity raw', 14: 'T (Conductivity)',
  15: 'P1 (2)', 16: 'P1 (3)', 17: 'P1 (4)', 18: 'P1 (5)', 19: 'Counter input',
  20: 'SDI12 CH1', 21: 'SDI12 CH2', 22: 'SDI12 CH3', 23: 'SDI12 CH4',
  24: 'SDI12 CH5', 25: 'SDI12 CH6', 26: 'SDI12 CH7', 27: 'SDI12 CH8',
  28: 'SDI12 CH9', 29: 'SDI12 CH10', 30: 'TOB1 (2)', 31: 'TOB1 (3)',
  32: 'TOB1 (4)', 33: 'TOB1 (5)', 34: 'E', 35: 'F', 36: 'G', 37: 'mH20 (PBaro)',
  38: 'mH20 (P1-P2)', 39: 'mH20 (P1-P3)', 40: 'mH20 (P1-P4)', 41: 'mH20 (P1-P5)',
  42: 'Conductivity Tc (2)', 43: 'Conductivity Tc (3)', 44: 'T (Conductivity) (2)',
  45: 'T (Conductivity) (3)', 46: 'P2 (2)', 47: 'TOB2 (2)',
  48: 'AquaMaster Flow Rate', 49: 'AquaMaster Pressure',
  50: 'AquaMaster Custom Flow Units', 51: 'AquaMaster External Supply Voltage',
  52: 'Tank Content 1', 53: 'Tank Content 2', 54: 'Tank Content 3'
};

// Per device-type channel layout (verbatim from upstream deviceTypesToChannelNames).
var CHANNEL_NAMES = {
  0: [MAP[1], MAP[2], MAP[3], MAP[4], MAP[5], MAP[6]],
  1: [MAP[1], MAP[2], MAP[3], MAP[4], MAP[5], MAP[6]],
  2: [MAP[11], MAP[2], MAP[3], MAP[4], MAP[5], MAP[6], MAP[7], MAP[8]],
  3: [MAP[11], MAP[2], MAP[3], MAP[4], MAP[5], MAP[6], MAP[7], MAP[8]],
  4: [MAP[1], MAP[2], MAP[3], MAP[4], MAP[5], MAP[6], MAP[7], MAP[8], MAP[9], MAP[10]],
  5: [MAP[11], MAP[2], MAP[3], MAP[4], MAP[5], MAP[6], MAP[7], MAP[8], MAP[9], MAP[10], MAP[11]],
  6: [MAP[1], MAP[2], MAP[3], MAP[4], MAP[5], MAP[6], MAP[7], MAP[8], MAP[9], MAP[10], MAP[15], MAP[16], MAP[17], MAP[18], MAP[19]],
  7: [MAP[7], MAP[8], MAP[9], MAP[10], MAP[20], MAP[21], MAP[22], MAP[23], MAP[24], MAP[25], MAP[26], MAP[27], MAP[28], MAP[29]],
  8: [MAP[2], MAP[5], MAP[15], MAP[30], MAP[16], MAP[31], MAP[17], MAP[32], MAP[18], MAP[33], MAP[9], MAP[10], MAP[7], MAP[8], MAP[19]],
  9: [MAP[1], MAP[2], MAP[3], MAP[14], MAP[5], MAP[6], MAP[7], MAP[8], MAP[9], MAP[10], MAP[12], MAP[13]],
  10: [MAP[11], MAP[2], MAP[3], MAP[14], MAP[5], MAP[6], MAP[7], MAP[8], MAP[9], MAP[10], MAP[12], MAP[13]],
  11: [MAP[2], MAP[5], MAP[12], MAP[14], MAP[15], MAP[30], MAP[42], MAP[44], MAP[16], MAP[31], MAP[43], MAP[45], MAP[7], MAP[8], MAP[19]],
  13: [MAP[2], MAP[3], MAP[5], MAP[6], MAP[15], MAP[46], MAP[30], MAP[47], MAP[7], MAP[8], MAP[9], MAP[10], MAP[19]]
};

// Lower-case-first camelCase from an arbitrary channel label.
function camel(name) {
  var cleaned = name.replace(/[^A-Za-z0-9]+/g, ' ').replace(/^\s+|\s+$/g, '');
  var parts = cleaned.split(' ');
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) { continue; }
    if (out === '') {
      out = p.charAt(0).toLowerCase() + p.slice(1);
    } else {
      out = out + p.charAt(0).toUpperCase() + p.slice(1);
    }
  }
  return out;
}

function decodeMeasurement(bytes, data) {
  var ct = bytes[1];
  var names = CHANNEL_NAMES[ct];
  if (!names) {
    return { errors: ['unsupported device type (ct) ' + ct] };
  }

  var mask = bytesToBinaryString(bytes.slice(2, 4));
  var reverted = mask.split('').reverse().join(''); // LSB-first scan
  var setBits = mask.match(/1/g);
  var channelCount = setBits ? setBits.length : 0;
  if (channelCount === 0) {
    return { errors: ['measurement telegram has no active channels'] };
  }

  if (bytes.length < 4 + channelCount * 4) {
    return { errors: ['measurement telegram truncated: expected ' +
      (4 + channelCount * 4) + ' bytes, got ' + bytes.length] };
  }

  var water = {};
  var extras = {};
  var hasExtras = false;
  var firstIndex = reverted.indexOf('1');

  for (var i = 1; i <= channelCount; i++) {
    var msbIndex = i * 4;
    var value = bytesToFloat(bytes.slice(msbIndex, msbIndex + 4));
    var name = names[firstIndex];
    firstIndex = reverted.indexOf('1', firstIndex + 1);

    if (name === undefined) {
      // Set bit with no name in this device-type layout: keep as raw extra.
      extras['channel' + i] = round(value, 6);
      hasExtras = true;
      continue;
    }

    if (name === 'P1') {
      // medium pressure, bar -> water.pressure kPa
      water.pressure = round(value * 100, 4);
    } else if (name.indexOf('mH20') === 0) {
      // water-column level, metres of water -> water.level (m)
      water.level = round(value, 4);
    } else if (name === 'T' || name === 'TOB1' || name === 'TOB2' ||
               name.indexOf('T (Conductivity)') === 0) {
      // medium / water temperature -> water.temperature.current (degC)
      if (!water.temperature) { water.temperature = {}; }
      water.temperature.current = round(value, 2);
    } else if (name.indexOf('Conductivity') === 0) {
      // conductivity, mS/cm -> water.ec uS/cm
      water.ec = round(value * 1000, 2);
    } else if (name === 'PBaro') {
      extras.barometricPressureKpa = round(value * 100, 4);
      hasExtras = true;
    } else if (name === 'TBaro') {
      extras.barometerTemperature = round(value, 2);
      hasExtras = true;
    } else {
      // P2, P3, differential Pd, voltage inputs, counters, SDI-12,
      // AquaMaster, tank content, etc. -> camelCase extras.
      extras[camel(name)] = round(value, 6);
      hasExtras = true;
    }
  }

  if (water.pressure === undefined && water.level === undefined) {
    return { errors: ['measurement telegram carries no water.level or ' +
      'water.pressure channel'] };
  }

  data.water = water;
  data.connectionType = ct;
  if (hasExtras) { data.channels = extras; }
  return { data: data };
}

function decodeDeviceInfo(bytes, data) {
  if (bytes.length < 20) {
    return { errors: ['device information telegram truncated: expected 20 ' +
      'bytes, got ' + bytes.length] };
  }
  data.battery = round(bytesToFloat(bytes.slice(14, 18)), 3);
  data.batteryPercent = bytes[18];
  data.enclosureHumidity = bytes[19];
  data.classGroup = pad2(bytes[2]) + '.' + pad2(bytes[3]);
  data.swVersion = pad2(bytes[4]) + '.' + pad2(bytes[5]);
  data.serialNumber = bytesToInt(bytes.slice(6, 10));
  data.deviceDatetime = bytesToDate(bytes.slice(10, 14));
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload (no reading)'] };
  }

  var functionCode = bytes[0];
  var data = {};

  if (functionCode === 1) {
    return decodeMeasurement(bytes, data);
  }
  if (functionCode === 12) {
    return decodeDeviceInfo(bytes, data);
  }
  return { errors: ['unsupported function code ' + functionCode] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "keller";
    result.data.model = "arc1-box";
  }
  return result;
}
