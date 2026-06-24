// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RAKwireless RAK2560 Sensor Hub (environmental
// monitoring node: air temperature, relative humidity, barometric pressure,
// motion/presence, illuminance, battery voltage and GPS, depending on the
// attached WisBlock modules).
//
// The RAK2560 emits the RAKwireless "Standardized Payload", a Cayenne-LPP-style
// self-describing TLV stream. Each field is [channel][type][value...]; the
// channel is an arbitrary per-sensor id and the type selects the size, sign and
// per-bit resolution. Wire format understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/rakwireless/decoder-rakwireless-standardized-payload.js, the
// RAKwireless Standardized Payload / Cayenne-LPP decoder; attributed in NOTICE).
//
// Ported from upstream: the LPP TLV walk, the per-type size/sign/divisor table,
// big-endian assembly, two's-complement sign extension and per-bit scaling are a
// faithful reimplementation of the upstream lppDecode(). We author the
// normalization ourselves, routing each decoded field to a normalized vocabulary
// key (rather than upstream's flat `name_channel` map):
//   temperature (103)             -> air.temperature (degC)
//   humidity (104, 0.5%/bit)      -> air.relativeHumidity (%)
//   humidityPrec (112, 0.1%/bit)  -> air.relativeHumidity (%)
//   barometer (115, 0.1 hPa/bit)  -> air.pressure (hPa, already atmospheric)
//   concentration (125, ppm)      -> air.co2 (ppm)
//   illuminance (101, lux)        -> air.lightIntensity (lux)
//   presence (102)                -> action.motion.detected (boolean)
//   voltage (116, 0.01 V/bit)     -> battery (V)
//   gps (136 / 137)               -> position.latitude / position.longitude
// Every other recognized LPP type has no normalized vocabulary home and is
// emitted as a camelCase extra keyed `<name><Channel>` (e.g. analogIn1,
// pyranometer3, gpsAltitude7) to preserve the multi-channel, multi-sensor shape.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// LPP sensor type table (size in bytes, signed flag, per-bit divisor).
function lppTypes() {
  return {
    0: { size: 1, name: 'digitalIn', signed: false, divisor: 1 },
    1: { size: 1, name: 'digitalOut', signed: false, divisor: 1 },
    2: { size: 2, name: 'analogIn', signed: true, divisor: 100 },
    3: { size: 2, name: 'analogOut', signed: true, divisor: 100 },
    100: { size: 4, name: 'generic', signed: false, divisor: 1 },
    101: { size: 2, name: 'illuminance', signed: false, divisor: 1 },
    102: { size: 1, name: 'presence', signed: false, divisor: 1 },
    103: { size: 2, name: 'temperature', signed: true, divisor: 10 },
    104: { size: 1, name: 'humidity', signed: false, divisor: 2 },
    112: { size: 2, name: 'humidityPrec', signed: true, divisor: 10 },
    113: { size: 6, name: 'accelerometer', signed: true, divisor: 1000 },
    115: { size: 2, name: 'barometer', signed: false, divisor: 10 },
    116: { size: 2, name: 'voltage', signed: false, divisor: 100 },
    117: { size: 2, name: 'current', signed: false, divisor: 1000 },
    118: { size: 4, name: 'frequency', signed: false, divisor: 1 },
    120: { size: 1, name: 'percentage', signed: false, divisor: 1 },
    121: { size: 2, name: 'altitude', signed: true, divisor: 1 },
    125: { size: 2, name: 'concentration', signed: false, divisor: 1 },
    128: { size: 2, name: 'power', signed: false, divisor: 1 },
    130: { size: 4, name: 'distance', signed: false, divisor: 1000 },
    131: { size: 4, name: 'energy', signed: false, divisor: 1000 },
    132: { size: 2, name: 'direction', signed: false, divisor: 1 },
    133: { size: 4, name: 'time', signed: false, divisor: 1 },
    134: { size: 6, name: 'gyrometer', signed: true, divisor: 100 },
    135: { size: 3, name: 'colour', signed: false, divisor: 1 },
    136: { size: 9, name: 'gps', signed: true, divisor: [10000, 10000, 100] },
    137: { size: 11, name: 'gps', signed: true, divisor: [1000000, 1000000, 100] },
    138: { size: 2, name: 'voc', signed: false, divisor: 1 },
    142: { size: 1, name: 'switch', signed: false, divisor: 1 },
    188: { size: 2, name: 'soilMoist', signed: false, divisor: 10 },
    190: { size: 2, name: 'windSpeed', signed: false, divisor: 100 },
    191: { size: 2, name: 'windDirection', signed: false, divisor: 1 },
    192: { size: 2, name: 'soilEc', signed: false, divisor: 1000 },
    193: { size: 2, name: 'soilPhH', signed: false, divisor: 100 },
    194: { size: 2, name: 'soilPhL', signed: false, divisor: 10 },
    195: { size: 2, name: 'pyranometer', signed: false, divisor: 1 },
    203: { size: 1, name: 'light', signed: false, divisor: 1 }
  };
}

// Big-endian assembly + optional two's-complement sign extension + divisor
// scaling, over a byte slice [start, end). Ported from upstream arrayToDecimal.
function decimalFrom(bytes, start, end, isSigned, divisor) {
  var value = 0;
  var len = end - start;
  for (var i = start; i < end; i++) {
    value = (value * 256) + (bytes[i] & 0xff);
  }
  if (isSigned) {
    var edge = Math.pow(2, len * 8);
    var max = (edge - 1) / 2;
    if (value > max) {
      value = value - edge;
    }
  }
  return value / divisor;
}

function setMotion(data, detected) {
  if (!data.action) {
    data.action = {};
  }
  if (!data.action.motion) {
    data.action.motion = {};
  }
  data.action.motion.detected = detected;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var types = lppTypes();
  var data = {};
  var air = {};
  var position = {};
  var hasAir = false;
  var hasPosition = false;

  var i = 0;
  while (i < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];
    i += 2;

    var def = types[type];
    if (!def) {
      return { errors: ['unrecognized LPP sensor type: ' + type] };
    }
    if (i + def.size > bytes.length) {
      return { errors: ['truncated payload: incomplete value for type ' + type] };
    }

    switch (type) {
      case 103: // temperature
        air.temperature = round(decimalFrom(bytes, i, i + 2, true, 10), 1);
        hasAir = true;
        break;
      case 104: // humidity (0.5 % per bit)
        air.relativeHumidity = round(decimalFrom(bytes, i, i + 1, false, 2), 1);
        hasAir = true;
        break;
      case 112: // precise humidity (0.1 %RH per bit)
        air.relativeHumidity = round(decimalFrom(bytes, i, i + 2, true, 10), 1);
        hasAir = true;
        break;
      case 115: // barometer (0.1 hPa per bit) -> atmospheric pressure
        air.pressure = round(decimalFrom(bytes, i, i + 2, false, 10), 1);
        hasAir = true;
        break;
      case 125: // concentration (ppm) -> CO2
        air.co2 = round(decimalFrom(bytes, i, i + 2, false, 1), 0);
        hasAir = true;
        break;
      case 101: // illuminance (lux)
        air.lightIntensity = round(decimalFrom(bytes, i, i + 2, false, 1), 0);
        hasAir = true;
        break;
      case 102: // presence -> motion detected
        setMotion(data, decimalFrom(bytes, i, i + 1, false, 1) !== 0);
        break;
      case 116: // voltage -> battery (V)
        data.battery = round(decimalFrom(bytes, i, i + 2, false, 100), 2);
        break;
      case 136: // GPS (0.0001 deg)
        position.latitude = round(decimalFrom(bytes, i + 0, i + 3, true, 10000), 4);
        position.longitude = round(decimalFrom(bytes, i + 3, i + 6, true, 10000), 4);
        data['gpsAltitude' + channel] = round(decimalFrom(bytes, i + 6, i + 9, true, 100), 2);
        hasPosition = true;
        break;
      case 137: // precise GPS (0.000001 deg)
        position.latitude = round(decimalFrom(bytes, i + 0, i + 4, true, 1000000), 6);
        position.longitude = round(decimalFrom(bytes, i + 4, i + 8, true, 1000000), 6);
        data['gpsAltitude' + channel] = round(decimalFrom(bytes, i + 8, i + 11, true, 100), 2);
        hasPosition = true;
        break;
      case 113: // accelerometer -> camelCase extra
        data['accelerometer' + channel] = {
          x: round(decimalFrom(bytes, i + 0, i + 2, true, 1000), 3),
          y: round(decimalFrom(bytes, i + 2, i + 4, true, 1000), 3),
          z: round(decimalFrom(bytes, i + 4, i + 6, true, 1000), 3)
        };
        break;
      case 134: // gyrometer -> camelCase extra
        data['gyrometer' + channel] = {
          x: round(decimalFrom(bytes, i + 0, i + 2, true, 100), 2),
          y: round(decimalFrom(bytes, i + 2, i + 4, true, 100), 2),
          z: round(decimalFrom(bytes, i + 4, i + 6, true, 100), 2)
        };
        break;
      case 135: // colour -> camelCase extra
        data['colour' + channel] = {
          r: decimalFrom(bytes, i + 0, i + 1, false, 1),
          g: decimalFrom(bytes, i + 1, i + 2, false, 1),
          b: decimalFrom(bytes, i + 2, i + 3, false, 1)
        };
        break;
      default: // every other recognized type -> camelCase extra
        data[def.name + channel] = round(
          decimalFrom(bytes, i, i + def.size, def.signed, def.divisor),
          3
        );
        break;
    }

    i += def.size;
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasPosition) {
    data.position = position;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "rakwireless";
    result.data.model = "rak2560";
  }
  return result;
}
