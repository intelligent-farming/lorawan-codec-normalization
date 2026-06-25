// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for alpha-omega-technology/klax (KLAX LoRaWAN
// electricity meter reader: an optical head that reads modern electricity
// meters and reports cumulative energy registers plus, depending on the
// configured filters, instantaneous power/voltage/current/frequency).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/alpha-omega-technology/klax.js,
// attributed in NOTICE). Wire format understood from that reference;
// normalization authored here (the upstream output is a nested vendor
// structure, not a normalized measurement).
//
// Only the "app" data uplink (fPort 3) carries calibrated meter readings.
// Each app frame is: header[2] + msgInfo[2] + a sequence of payload blocks,
// each prefixed by a 1-byte handler id. Register blocks (historic id=1 for
// protocol version 0, filter id=1 otherwise, and "now" id=2) carry the meter
// register values; the register's unit byte selects the physical quantity.
// We map each register's current (most recent) valid value onto the
// vocabulary key for its unit. Config/info/register-management uplinks
// (fPort 100/101/103/104/105) carry no calibrated measurement and are
// rejected.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Register unit ids, per the KLAX protocol.
var REGISTER_UNITS = [
  'NDEF', 'Wh', 'W', 'V', 'A', 'Hz', 'varh', 'var', 'VAh', 'VA'
];

function decodeInt32BE(data, off) {
  var val = (data[off] << 24) | (data[off + 1] << 16) |
            (data[off + 2] << 8) | data[off + 3];
  return val; // already signed (32-bit bitops)
}

// Manual IEEE-754 single-precision big-endian decode (no Buffer/DataView).
function decodeFloatBE(data, off) {
  var b0 = data[off], b1 = data[off + 1], b2 = data[off + 2], b3 = data[off + 3];
  var mantissa = b3 | (b2 << 8) | ((b1 & 0x7f) << 16);
  var exponent = ((b1 & 0x80) >> 7) | ((b0 & 0x7f) << 1);
  var sign = (b0 & 0x80) ? -1 : 1;
  if (exponent === 255) {
    if (mantissa > 0) {
      return NaN;
    }
    return sign * Infinity;
  }
  if (exponent > 0) {
    exponent -= 127;
    return sign * (Math.pow(2, exponent) +
      mantissa * Math.pow(2, exponent - 23));
  }
  exponent = -126;
  return sign * (mantissa * Math.pow(2, exponent - 23));
}

function parseHeader(bytes) {
  var version = (bytes[0] & 0xfc) >> 2;
  var deviceType = bytes[0] & 0x3; // 0 = SML, 1 = MODBUS
  var batteryPercent;
  if (version > 0) {
    batteryPercent = (bytes[1] & 0x7) * 20;
  } else {
    batteryPercent = (bytes[1] & 0xf) * 10;
  }
  var configured = (bytes[1] & 0x40) > 0;
  return {
    version: version,
    deviceType: deviceType,
    batteryPercent: batteryPercent,
    configured: configured
  };
}

// Pull (value, valid) out of a historic/now register: four int32 values.
function readInt32Register(bytes, off) {
  var values = [];
  var anyValid = false;
  for (var i = 0; i < 4; i++) {
    var v = decodeInt32BE(bytes, off + i * 4);
    if (v !== 0) {
      anyValid = true;
    }
    values.push(v);
  }
  return { values: values, valid: anyValid };
}

// Map a register unit + a representative value into the measurement object.
// The most recent (index 0) value is the current reading.
function applyRegister(data, extras, unitId, value) {
  var unit = (unitId >= 0 && unitId < REGISTER_UNITS.length) ?
    REGISTER_UNITS[unitId] : 'NDEF';
  if (unit === 'Wh') {
    if (!data.metering) { data.metering = {}; }
    if (!data.metering.energy) { data.metering.energy = {}; }
    data.metering.energy.total = round(value, 3);
    return true;
  }
  if (unit === 'W') {
    if (!data.power) { data.power = {}; }
    data.power.active = round(value, 3);
    return true;
  }
  if (unit === 'V') {
    if (!data.power) { data.power = {}; }
    data.power.voltage = round(value, 3);
    return true;
  }
  if (unit === 'A') {
    if (!data.power) { data.power = {}; }
    data.power.current = round(value, 3);
    return true;
  }
  if (unit === 'Hz') {
    if (!data.power) { data.power = {}; }
    data.power.frequency = round(value, 3);
    return true;
  }
  if (unit === 'VA') {
    if (!data.power) { data.power = {}; }
    data.power.apparent = round(value, 3);
    return true;
  }
  if (unit === 'varh') {
    extras.reactiveEnergyTotal = round(value, 3);
    return true;
  }
  if (unit === 'var') {
    extras.reactivePower = round(value, 3);
    return true;
  }
  if (unit === 'VAh') {
    extras.apparentEnergyTotal = round(value, 3);
    return true;
  }
  return false; // NDEF / unknown
}

// Historic block (version 0): regmask[1] + units[1] + reg1[16] (+ reg2[16]).
function handleHistoric(bytes, off, data, extras) {
  var regmask = bytes[off];
  var units = bytes[off + 1];
  var reg1Active = (regmask & 0x01) > 0;
  var reg2Active = (regmask & 0x10) > 0;
  var reg1Unit = units & 0x0f;
  var reg2Unit = (units & 0xf0) >> 4;
  var p = off + 2;
  if (reg1Active) {
    var r1 = readInt32Register(bytes, p);
    if (r1.valid) {
      applyRegister(data, extras, reg1Unit, r1.values[0]);
    }
  }
  p += 16;
  if (reg2Active) {
    var r2 = readInt32Register(bytes, p);
    if (r2.valid) {
      applyRegister(data, extras, reg2Unit, r2.values[0]);
    }
  }
}

// "Now" block: status[1] + unit01[1] + unit23[1] + 4 x value[4].
function handleNow(bytes, off, data, extras, asFloat) {
  for (var i = 0; i < 4; i++) {
    var set = (bytes[off] & (1 << i)) > 0;
    var valid = (bytes[off] & (1 << (i + 4))) > 0;
    var unitByte = bytes[i >= 2 ? off + 2 : off + 1];
    var unitId = (i % 2 === 0) ? (unitByte & 0x0f) : ((unitByte & 0xf0) >> 4);
    var voff = off + 3 + (4 * i);
    var value = asFloat ? decodeFloatBE(bytes, voff) : decodeInt32BE(bytes, voff);
    if (set && valid && isFinite(value)) {
      applyRegister(data, extras, unitId, value);
    }
  }
}

// Filter block (version > 0): flags[1] + valid[1] + 4 x float value[4].
function handleFilter(bytes, off, data, extras) {
  var unitId = (bytes[off] & 0xf0) >> 4;
  var dataValid = bytes[off + 1] & 0xf;
  // The four floats are a history series; the first valid one is current.
  for (var i = 0; i < 4; i++) {
    var valid = (dataValid & (1 << i)) > 0;
    if (valid) {
      var value = decodeFloatBE(bytes, off + 2 + i * 4);
      if (isFinite(value)) {
        applyRegister(data, extras, unitId, value);
        return;
      }
    }
  }
}

// Handler ids and their fixed payload lengths (excluding the 1-byte id).
function handlerLength(id, version) {
  if (id === 1) { return version === 0 ? 34 : 18; }
  if (id === 2) { return 19; }
  if (id === 3) { return 10; } // serverID
  if (id === 4) { return 10; }
  if (id === 5) { return 18; }
  if (id === 6) { return 34; }
  if (id === 7) { return 1; }
  if (id === 8) { return 4; }
  return -1;
}

function decodeApp(bytes) {
  var header = parseHeader(bytes);
  var data = {};
  var extras = {};
  var off = 4; // skip header[2] + msgInfo[2]
  while (off < bytes.length) {
    var id = bytes[off];
    var len = handlerLength(id, header.version);
    if (len < 0) {
      break; // unknown payload type — stop parsing here
    }
    off += 1;
    if (off + len > bytes.length) {
      break; // truncated block
    }
    if (id === 1) {
      if (header.version === 0) {
        handleHistoric(bytes, off, data, extras);
      } else {
        handleFilter(bytes, off, data, extras);
      }
    } else if (id === 2) {
      // version 0 -> int32, otherwise float
      handleNow(bytes, off, data, extras, header.version !== 0);
    }
    // ids 3..8 are server/device id and modbus status: no measurement.
    off += len;
  }

  var hasMeasurement = false;
  var k;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasMeasurement = true;
    }
  }
  if (!hasMeasurement) {
    return { errors: ['no calibrated meter register in app uplink'] };
  }

  data.batteryPercent = header.batteryPercent;
  var ek;
  for (ek in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, ek)) {
      data[ek] = extras[ek];
    }
  }
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 4) {
    return { errors: ['empty or too-short payload'] };
  }
  if (port !== 3) {
    return {
      errors: ['unsupported fPort ' + port +
        ' (only the app data uplink on fPort 3 carries meter readings)']
    };
  }
  return decodeApp(bytes);
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "alpha-omega-technology";
    result.data.model = "klax";
  }
  return result;
}
