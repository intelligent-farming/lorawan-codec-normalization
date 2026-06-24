// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for rakwireless/rak2270 (RAK2270 WisNode Sticker
// Tracker — 3-axis accelerometer + temperature, Cayenne LPP wire format).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/rakwireless, RAKwireless Standardized
// Payload / Cayenne LPP; attributed in NOTICE). The wire format (channel + LPP
// type + big-endian payload, per-type size/sign/divisor) is preserved faithfully;
// the normalization to the shared vocabulary is authored here, not copied from
// upstream's normalizeUplink.
//
// Cayenne LPP types used by this device:
//   113 accelerometer  6 bytes  signed  0.001 g per axis  -> vibration.acceleration{X,Y,Z}
//   103 temperature    2 bytes  signed  0.1 °C            -> air.temperature
//   116 voltage        2 bytes  unsigned 0.01 V           -> battery
//   120 percentage     1 byte   unsigned 1 %              -> batteryPercent
// Any other LPP channel is emitted as a camelCase extra "<name>Ch<channel>".

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function arrayToDecimal(stream, isSigned, divisor) {
  var value = 0;
  var i;
  for (i = 0; i < stream.length; i++) {
    if (stream[i] > 0xff || stream[i] < 0) {
      throw new Error('byte value out of range');
    }
    value = (value * 256) + stream[i];
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

function lppDecode(bytes) {
  var sensorTypes = {
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
    142: { size: 1, name: 'switch', signed: false, divisor: 1 }
  };

  var sensors = [];
  var i = 0;
  while (i < bytes.length) {
    var channel = bytes[i++];
    var sType = bytes[i++];
    if (typeof sType === 'undefined') {
      throw new Error('truncated payload: missing type byte');
    }
    var type = sensorTypes[sType];
    if (typeof type === 'undefined') {
      throw new Error('unsupported LPP type: ' + sType);
    }
    if (i + type.size > bytes.length) {
      throw new Error('truncated payload for type ' + sType);
    }

    var value;
    if (sType === 113 || sType === 134) {
      value = {
        x: arrayToDecimal(bytes.slice(i, i + 2), type.signed, type.divisor),
        y: arrayToDecimal(bytes.slice(i + 2, i + 4), type.signed, type.divisor),
        z: arrayToDecimal(bytes.slice(i + 4, i + 6), type.signed, type.divisor)
      };
    } else {
      value = arrayToDecimal(bytes.slice(i, i + type.size), type.signed, type.divisor);
    }

    sensors.push({ channel: channel, type: sType, name: type.name, value: value });
    i += type.size;
  }
  return sensors;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || typeof bytes.length !== 'number') {
    return { errors: ['no bytes in uplink'] };
  }
  if (bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var fields;
  try {
    fields = lppDecode(bytes);
  } catch (e) {
    return { errors: [String(e && e.message ? e.message : e)] };
  }

  var data = {};
  var j;
  for (j = 0; j < fields.length; j++) {
    var f = fields[j];
    if (f.type === 113) {
      data['vibration.accelerationX'] = round(f.value.x, 3);
      data['vibration.accelerationY'] = round(f.value.y, 3);
      data['vibration.accelerationZ'] = round(f.value.z, 3);
    } else if (f.type === 103) {
      data['air.temperature'] = round(f.value, 1);
    } else if (f.type === 116) {
      data.battery = round(f.value, 2);
    } else if (f.type === 120) {
      data.batteryPercent = round(f.value, 0);
    } else if (f.type === 134) {
      data['gyrometerCh' + f.channel] = {
        x: round(f.value.x, 2),
        y: round(f.value.y, 2),
        z: round(f.value.z, 2)
      };
    } else {
      data[f.name + 'Ch' + f.channel] = f.value;
    }
  }

  if (Object.keys(data).length === 0) {
    return { errors: ['no decodable fields in payload'] };
  }
  return { data: data };
}
