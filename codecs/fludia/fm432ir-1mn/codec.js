// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for fludia/fm432ir-1mn — a Fludia FM432ir optical
// pulse reader clamped onto a German electricity meter, reporting a cumulative
// energy index plus a series of per-minute average powers.
//
// decodeUplink ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/fludia/fm432ir-1mn-decode.js,
// attributed in NOTICE). The message-type dispatch (T1/T2 mME and MECA frames),
// the big-endian index decode and the per-interval power series are reproduced
// faithfully; the mapping to vocabulary keys is authored here.
//
// Mapping:
//   index (Wh)          -> metering.energy.total  (cumulative active energy)
//   most-recent power W  -> power.active           (last non-null sample of the series)
//   powers[] (W)         -> camelCase extra `powers` (full per-interval series)
// meter type / firmware / battery / starts / time step / scalers / message type
// are camelCase extras. A negative or null index is not emitted as the (>= 0)
// vocabulary energy total; a signed index is kept as the extra `signedEnergyIndex`.

var PAYLOAD_TYPE = {
  T1_E_SUM: { header: 0x2e, size: 42, name: 'T1_E_SUM' },
  T1_E_POS: { header: 0x2f, size: 42, name: 'T1_E_POS' },
  T1_E_NEG: { header: 0x30, size: 42, name: 'T1_E_NEG' },
  T2_MME: { header: 0x2a, size: 18, name: 'T2_MME' },
  T1_MECA_1MN: { header: 0x5b, size: 45, name: 'T1_MECA_1MN' },
  T2_MECA: { header: 0x4b, size: 12, name: 'T2_MECA' },
  TT1_MECA: { header: 0x12, size: 37, name: 'TT1_MECA' },
  TT2_MECA: { header: 0x13, size: 30, name: 'TT2_MECA' },
  START: { header: 0x5f, size: 9, name: 'START' }
};

function toHexString(byteArray) {
  var s = '';
  var i;
  for (i = 0; i < byteArray.length; i++) {
    s += ('0' + (byteArray[i] & 0xff).toString(16)).slice(-2);
  }
  return s;
}

function toSignedInt8(b) {
  if (b & 0x80) { return (b & 0x7f) - 0x80; }
  return b & 0x7f;
}

function toSignedInt16(b1, b2) {
  if (b1 & 0x80) { return (((b1 & 0x7f) - 0x80) << 8) | b2; }
  return ((b1 & 0x7f) << 8) | b2;
}

function toUnsignedInt16(b1, b2) {
  return ((b1 & 0xff) << 8) | b2;
}

function findMessageType(p) {
  var T = PAYLOAD_TYPE;
  if (p[0] === 0xf0) {
    if (p[1] === T.T1_E_SUM.header && p.length === T.T1_E_SUM.size) { return T.T1_E_SUM.name; }
    if (p[1] === T.T1_E_POS.header && p.length === T.T1_E_POS.size) { return T.T1_E_POS.name; }
    if (p[1] === T.T1_E_NEG.header && p.length === T.T1_E_NEG.size) { return T.T1_E_NEG.name; }
    if (p[1] === T.T2_MME.header && p.length === T.T2_MME.size) { return T.T2_MME.name; }
    return null;
  }
  if (p[0] === T.T1_MECA_1MN.header && p.length === T.T1_MECA_1MN.size) { return T.T1_MECA_1MN.name; }
  if (p[0] === T.T2_MECA.header && p.length === T.T2_MECA.size) { return T.T2_MECA.name; }
  if (p[0] === T.TT1_MECA.header && p.length === T.TT1_MECA.size) { return T.TT1_MECA.name; }
  if (p[0] === T.TT2_MECA.header && p.length === T.TT2_MECA.size) { return T.TT2_MECA.name; }
  if (p[0] === T.START.header && p.length === T.START.size) { return T.START.name; }
  return null;
}

function decodeT1mme(payload, typeName) {
  var data = { powers: [], warnings: [] };
  var hex = toHexString(payload);
  data.timeStep = payload[2];
  var signed = payload[3];
  if (!signed) {
    data.index = parseInt(hex.substring(8, 24), 16) / 10;
  } else if (payload[4] & 0x80) {
    if (!(payload[4] === 0xff && (payload[5] >> 4) === 0xff && (payload[6] >> 4) === 0xff && (payload[7] >> 4) === 0xff)) {
      data.warnings.push('Overflow with index value');
    }
    data.index = (parseInt(hex.substring(16, 24), 16) >> 0) / 10;
  } else {
    data.index = parseInt(hex.substring(8, 24), 16) / 10;
  }
  if (typeName === PAYLOAD_TYPE.T1_E_NEG.name && data.index > 0) {
    data.index = -data.index;
  }
  var i;
  for (i = 0; i < 15; i++) {
    var hi = payload[12 + i * 2];
    var lo = payload[13 + i * 2];
    if (hi === 0xff && (lo === 0xff || lo === 0xfe || lo === 0xfd || lo === 0xfc || lo === 0xfb)) {
      data.powers.push(null);
    } else {
      var v = signed ? toSignedInt16(hi, lo) / 10 : toUnsignedInt16(hi, lo) / 10;
      if (typeName === PAYLOAD_TYPE.T1_E_NEG.name && v > 0) { v = -v; }
      data.powers.push(v);
    }
  }
  return data;
}

function decodeT1meca(payload) {
  var data = { powers: [] };
  data.index = ((payload[1] & 0xff) << 24) | ((payload[2] & 0xff) << 16) | ((payload[3] & 0xff) << 8) | (payload[4] & 0xff);
  var i;
  for (i = 0; i < 20; i++) {
    data.powers.push(((payload[5 + 2 * i] & 0xff) << 8) | (payload[6 + 2 * i] & 0xff));
  }
  return data;
}

function decodeT2meca(payload) {
  var data = {};
  data.numberOfStarts = payload[1];
  data.index = ((payload[5] & 0xff) << 24) | ((payload[6] & 0xff) << 16) | ((payload[7] & 0xff) << 8) | (payload[8] & 0xff);
  data.firmwareVersion = payload[4] >> 2;
  data.lowBattery = payload[4] & 0x1;
  data.meterType = 'Electromechanical (Position A)';
  data.timeStep = payload[11];
  if (data.timeStep === 0) { data.timeStep = 10; }
  if (data.timeStep === 3) { data.timeStep = 15; }
  if (data.timeStep === 1) { data.timeStep = 60; }
  return data;
}

function decodeT2mme(payload) {
  var data = { warnings: [] };
  var hex = toHexString(payload);
  data.timeStep = payload[2];
  var measure = payload[3];
  if (measure === 0) { data.typeOfMeasure = 'E-POS values (OBIS code 1.8.0)'; }
  if (measure === 1) { data.typeOfMeasure = 'E-SUM values (OBIS code 16.8.0)'; }
  if (measure === 2) { data.typeOfMeasure = 'E-NEG values (OBIS code 2.8.0)'; }
  data.firmwareVersion = payload[5];
  data.sensorSensitivity = payload[6];
  data.scalerEPos = payload[7] === 0x7f ? null : Math.pow(10, toSignedInt8(payload[7]));
  data.scalerESum = payload[8] === 0x7f ? null : Math.pow(10, toSignedInt8(payload[8]));
  data.scalerENeg = payload[9] === 0x7f ? null : Math.pow(10, toSignedInt8(payload[9]));
  if (measure === 0) { data.index = parseInt(hex.substring(20, 36), 16) / 10; }
  if (measure === 1) {
    if (payload[10] & 0x80) {
      if (!(payload[10] === 0xff && payload[11] === 0xff && payload[12] === 0xff && payload[13] === 0xff)) {
        data.warnings.push('Overflow with index value');
      }
      data.index = (parseInt(hex.substring(28, 36), 16) >> 0) / 10;
    } else {
      data.index = parseInt(hex.substring(20, 36), 16) / 10;
    }
  }
  if (measure === 2) { data.index = -parseInt(hex.substring(20, 36), 16) / 10; }
  return data;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var typeName = findMessageType(bytes);
  if (typeName === null) {
    return { errors: ['Invalid payload'] };
  }

  var raw = { messageType: typeName };
  var warnings = [];

  if (typeName === PAYLOAD_TYPE.T1_E_SUM.name || typeName === PAYLOAD_TYPE.T1_E_POS.name || typeName === PAYLOAD_TYPE.T1_E_NEG.name) {
    var a = decodeT1mme(bytes, typeName);
    raw.index = a.index; raw.powers = a.powers; raw.timeStep = a.timeStep; raw.meterType = 'mME (Position B)';
    warnings = a.warnings;
  } else if (typeName === PAYLOAD_TYPE.T2_MME.name) {
    var b = decodeT2mme(bytes);
    raw.index = b.index; raw.timeStep = b.timeStep; raw.meterType = 'mME (Position B)';
    raw.firmwareVersion = b.firmwareVersion; raw.typeOfMeasure = b.typeOfMeasure;
    raw.scalerEPos = b.scalerEPos; raw.scalerESum = b.scalerESum; raw.scalerENeg = b.scalerENeg;
    raw.sensorSensitivity = b.sensorSensitivity;
    warnings = b.warnings;
  } else if (typeName === PAYLOAD_TYPE.T1_MECA_1MN.name) {
    var c = decodeT1meca(bytes);
    raw.index = c.index; raw.powers = c.powers;
  } else if (typeName === PAYLOAD_TYPE.T2_MECA.name) {
    var d = decodeT2meca(bytes);
    raw.index = d.index; raw.meterType = d.meterType; raw.lowBattery = d.lowBattery;
    raw.firmwareVersion = d.firmwareVersion; raw.numberOfStarts = d.numberOfStarts; raw.timeStep = d.timeStep;
  } else if (typeName === PAYLOAD_TYPE.TT1_MECA.name || typeName === PAYLOAD_TYPE.TT2_MECA.name) {
    raw.meterType = 'Electromechanical (Position A)';
  }

  // Normalize to the shared vocabulary.
  var data = {};

  if (raw.index !== undefined && raw.index !== null) {
    if (raw.index >= 0) {
      data.metering = { energy: { total: raw.index } }; // Wh
    } else {
      data.signedEnergyIndex = raw.index;
    }
  }

  if (raw.powers && raw.powers.length) {
    var latest = null;
    var i;
    for (i = raw.powers.length - 1; i >= 0; i--) {
      if (raw.powers[i] !== null && raw.powers[i] !== undefined) { latest = raw.powers[i]; break; }
    }
    if (latest !== null) {
      data.power = { active: latest }; // W, most-recent interval
    }
    data.powers = raw.powers;
  }

  // Genuine non-vocabulary fields -> camelCase extras.
  data.messageType = raw.messageType;
  if (raw.meterType !== undefined) { data.meterType = raw.meterType; }
  if (raw.firmwareVersion !== undefined) { data.firmwareVersion = raw.firmwareVersion; }
  if (raw.lowBattery !== undefined) { data.lowBattery = raw.lowBattery; }
  if (raw.numberOfStarts !== undefined) { data.numberOfStarts = raw.numberOfStarts; }
  if (raw.timeStep !== undefined) { data.timeStep = raw.timeStep; }
  if (raw.typeOfMeasure !== undefined) { data.typeOfMeasure = raw.typeOfMeasure; }
  if (raw.sensorSensitivity !== undefined) { data.sensorSensitivity = raw.sensorSensitivity; }
  if (raw.scalerEPos !== undefined) { data.scalerEPos = raw.scalerEPos; }
  if (raw.scalerESum !== undefined) { data.scalerESum = raw.scalerESum; }
  if (raw.scalerENeg !== undefined) { data.scalerENeg = raw.scalerENeg; }

  if (warnings && warnings.length) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "fludia";
    result.data.model = "fm432ir-1mn";
  }
  return result;
}
