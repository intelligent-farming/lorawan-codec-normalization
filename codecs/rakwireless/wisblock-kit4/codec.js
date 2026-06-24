// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RAKwireless WisBlock Kit 4 (Indoor Air-Quality /
// Environment Monitor — RAK4631 base with RAK1906 BME680: air temperature,
// humidity, barometric pressure, and gas/IAQ).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire format
// (the RAKwireless "Standardized Payload" Cayenne-LPP channel stream) ported from
// the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/rakwireless,
// decoder-rakwireless-standardized-payload.js — the RAKwireless Standardized
// Payload / Cayenne-LPP decoder; attributed in NOTICE) and the LwM2M/LPP channel
// table documented therein.
//
// Ported from upstream lppDecode: the payload is a sequence of LPP records, each
//   [channel, type, <type.size data bytes>]   (multi-byte fields big-endian)
// We faithfully decode the same channel/type/size/sign/divisor table as upstream,
// then NORMALIZE each decoded field into the shared vocabulary instead of
// emitting upstream's "<name>_<channel>" keys. For the RAK1906 BME680 the device
// emits temperature (type 103), humidity (104), barometer (115) and the BSEC
// gas/air-quality reading as a VOC/IAQ index (138).
//
// Normalization mapping:
//   temperature (103)        -> air.temperature (degC)
//   humidity    (104)        -> air.relativeHumidity (%)
//   humidity_prec (112)      -> air.relativeHumidity (%)
//   barometer   (115)        -> air.pressure (hPa, atmospheric)
//   concentration (125)      -> air.co2 (ppm)
//   illuminance (101)        -> air.lightIntensity (lux, numeric)
//   voltage     (116)        -> battery (V)
//   percentage  (120)        -> batteryPercent (extra)
//   voc/IAQ     (138)        -> iaq (extra; BME680 BSEC air-quality index)
// Fields with no vocabulary key (accelerometer, gyrometer, gps, ...) are emitted
// as camelCase extras keyed by their LPP name. Upstream throws on an unknown
// sensor type; we return { errors: [...] } instead, per the output contract.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// LPP channel/type table (verbatim sizes/signs/divisors from the upstream
// decoder's sensor_types map).
function lppTypes() {
  return {
    0: { size: 1, name: 'digital_in', signed: false, divisor: 1 },
    1: { size: 1, name: 'digital_out', signed: false, divisor: 1 },
    2: { size: 2, name: 'analog_in', signed: true, divisor: 100 },
    3: { size: 2, name: 'analog_out', signed: true, divisor: 100 },
    100: { size: 4, name: 'generic', signed: false, divisor: 1 },
    101: { size: 2, name: 'illuminance', signed: false, divisor: 1 },
    102: { size: 1, name: 'presence', signed: false, divisor: 1 },
    103: { size: 2, name: 'temperature', signed: true, divisor: 10 },
    104: { size: 1, name: 'humidity', signed: false, divisor: 2 },
    112: { size: 2, name: 'humidity_prec', signed: true, divisor: 10 },
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
    138: { size: 2, name: 'voc', signed: false, divisor: 1 },
    142: { size: 1, name: 'switch', signed: false, divisor: 1 },
    188: { size: 2, name: 'soil_moist', signed: false, divisor: 10 },
    190: { size: 2, name: 'wind_speed', signed: false, divisor: 100 },
    191: { size: 2, name: 'wind_direction', signed: false, divisor: 1 },
    192: { size: 2, name: 'soil_ec', signed: false, divisor: 1000 },
    193: { size: 2, name: 'soil_ph_h', signed: false, divisor: 100 },
    194: { size: 2, name: 'soil_ph_l', signed: false, divisor: 10 },
    195: { size: 2, name: 'pyranometer', signed: false, divisor: 1 },
    203: { size: 1, name: 'light', signed: false, divisor: 1 }
  };
}

// Big-endian decode of a byte slice with optional two's-complement sign and a
// divisor. Ported from upstream arrayToDecimal.
function bytesToValue(stream, isSigned, divisor) {
  var value = 0;
  var i;
  for (i = 0; i < stream.length; i++) {
    value = (value * 256) + (stream[i] & 0xff);
  }
  if (isSigned) {
    var edge = Math.pow(2, stream.length * 8);
    var max = (edge - 1) / 2;
    if (value > max) {
      value = value - edge;
    }
  }
  return value / divisor;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload: no LPP records'] };
  }

  var types = lppTypes();
  var fields = [];
  var i = 0;
  while (i < bytes.length) {
    var channel = bytes[i++];
    var type = bytes[i++];
    if (type === undefined || !types[type]) {
      return { errors: ['unrecognized LPP sensor type: ' + type] };
    }
    var def = types[type];
    if (i + def.size > bytes.length) {
      return {
        errors: ['truncated payload: type ' + type + ' needs ' + def.size + ' bytes']
      };
    }

    var value;
    if (type === 113 || type === 134) {
      // Accelerometer / gyrometer: three signed values, one per axis.
      value = {
        x: bytesToValue([bytes[i], bytes[i + 1]], def.signed, def.divisor),
        y: bytesToValue([bytes[i + 2], bytes[i + 3]], def.signed, def.divisor),
        z: bytesToValue([bytes[i + 4], bytes[i + 5]], def.signed, def.divisor)
      };
    } else if (type === 135) {
      // Colour: R/G/B bytes.
      value = {
        r: bytes[i],
        g: bytes[i + 1],
        b: bytes[i + 2]
      };
    } else {
      var slice = [];
      var k;
      for (k = 0; k < def.size; k++) {
        slice.push(bytes[i + k]);
      }
      value = bytesToValue(slice, def.signed, def.divisor);
    }

    fields.push({ channel: channel, type: type, name: def.name, value: value });
    i += def.size;
  }

  // Normalize the decoded LPP fields into the shared vocabulary.
  var data = {};
  var air = {};
  var hasAir = false;
  var j;
  for (j = 0; j < fields.length; j++) {
    var f = fields[j];
    switch (f.type) {
      case 103: // temperature, 0.1 degC
        air.temperature = round(f.value, 1);
        hasAir = true;
        break;
      case 104: // humidity, 0.5 %
        air.relativeHumidity = round(f.value, 1);
        hasAir = true;
        break;
      case 112: // precise humidity, 0.1 %RH
        air.relativeHumidity = round(f.value, 1);
        hasAir = true;
        break;
      case 115: // barometer, 0.1 hPa (atmospheric)
        air.pressure = round(f.value, 1);
        hasAir = true;
        break;
      case 125: // concentration -> CO2 (ppm)
        air.co2 = f.value;
        hasAir = true;
        break;
      case 101: // illuminance (lux) -> light intensity, numeric only
        air.lightIntensity = f.value;
        hasAir = true;
        break;
      case 116: // voltage (V) -> battery
        data.battery = round(f.value, 2);
        break;
      case 120: // percentage -> battery percent (extra)
        data.batteryPercent = f.value;
        break;
      case 138: // VOC/IAQ index (BME680 BSEC air-quality index) -> extra
        data.iaq = f.value;
        break;
      default:
        // No vocabulary mapping: keep the decoded value as a camelCase extra
        // keyed by its LPP name (extras must not collide with vocab keys).
        data[f.name] = f.value;
        break;
    }
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "rakwireless";
    result.data.model = "wisblock-kit4";
  }
  return result;
}
