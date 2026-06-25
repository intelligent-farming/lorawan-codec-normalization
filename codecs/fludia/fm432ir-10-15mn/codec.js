// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for fludia/fm432ir-10-15mn — a Fludia FM432ir optical
// pulse reader on a German electricity meter, in its 10/15-minute reporting
// configuration. It reports a cumulative energy index plus a series of
// per-interval consumption increments, from which average powers are derived.
//
// decodeUplink ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/fludia/fm432ir-10-15mn-decode.js,
// attributed in NOTICE). This variant's upstream supports many frame types; the
// fixed-step electromechanical data frames (T1_MECA_10MN/15MN/1H, header
// 0x48/0x49/0x4a) and the T2_MECA status frame carry the metering values and are
// ported faithfully here, including the upstream power = increment * 60 / step
// derivation. Other (adjustable-step / mME / Wh) frame variants are reported as
// an unsupported-frame error rather than risk a mis-decode; the network server
// can fall back for those.
//
// Mapping:
//   index (Wh)            -> metering.energy.total
//   most-recent power (W)  -> power.active (last non-null derived sample)
//   powers[] / increments[] -> camelCase extras
// meter type / firmware / battery / starts / time step -> camelCase extras.

var PAYLOAD_TYPE = {
  T1_MECA_10MN: { header: 0x48, size: 21, name: 'T1_MECA_10MN', step: 10 },
  T1_MECA_15MN: { header: 0x49, size: 21, name: 'T1_MECA_15MN', step: 15 },
  T1_MECA_1H: { header: 0x4a, size: 21, name: 'T1_MECA_1H', step: 60 },
  T2_MECA: { header: 0x4b, size: 12, name: 'T2_MECA' },
  START: { header: 0x01, size: 3, name: 'START' }
};

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function findMessageType(p) {
  var T = PAYLOAD_TYPE;
  if (p[0] === T.T1_MECA_10MN.header && p.length === T.T1_MECA_10MN.size) { return T.T1_MECA_10MN.name; }
  if (p[0] === T.T1_MECA_15MN.header && p.length === T.T1_MECA_15MN.size) { return T.T1_MECA_15MN.name; }
  if (p[0] === T.T1_MECA_1H.header && p.length === T.T1_MECA_1H.size) { return T.T1_MECA_1H.name; }
  if (p[0] === T.T2_MECA.header && p.length === T.T2_MECA.size) { return T.T2_MECA.name; }
  if (p[0] === T.START.header && p.length === T.START.size) { return T.START.name; }
  return null;
}

// Faithful port of the upstream fixed-step decode_T1_meca: 4-byte big-endian
// index, then 8 uint16 increments; power = increment * 60 / step.
function decodeT1meca(payload, step) {
  var data = { increments: [], powers: [] };
  data.index = ((payload[1] & 0xff) << 24) | ((payload[2] & 0xff) << 16) | ((payload[3] & 0xff) << 8) | (payload[4] & 0xff);
  var i;
  for (i = 0; i < 8; i++) {
    data.increments.push(((payload[5 + 2 * i] & 0xff) << 8) | (payload[6 + 2 * i] & 0xff));
  }
  for (i = 0; i < 8; i++) {
    data.powers.push(round(data.increments[i] * 60 / step, 3));
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

function stepFor(name) {
  var k;
  for (k in PAYLOAD_TYPE) {
    if (PAYLOAD_TYPE[k].name === name) { return PAYLOAD_TYPE[k].step; }
  }
  return null;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var typeName = findMessageType(bytes);

  if (typeName === null) {
    // Distinguish a totally unknown header from a known-but-unsupported frame.
    return { errors: ['unsupported or invalid frame (only fixed-step MECA frames are normalized)'] };
  }

  var raw = { messageType: typeName };

  if (typeName === PAYLOAD_TYPE.T1_MECA_10MN.name || typeName === PAYLOAD_TYPE.T1_MECA_15MN.name || typeName === PAYLOAD_TYPE.T1_MECA_1H.name) {
    var step = stepFor(typeName);
    var a = decodeT1meca(bytes, step);
    raw.index = a.index; raw.powers = a.powers; raw.increments = a.increments; raw.timeStep = step;
  } else if (typeName === PAYLOAD_TYPE.T2_MECA.name) {
    var b = decodeT2meca(bytes);
    raw.index = b.index; raw.numberOfStarts = b.numberOfStarts; raw.firmwareVersion = b.firmwareVersion;
    raw.lowBattery = b.lowBattery; raw.meterType = b.meterType; raw.timeStep = b.timeStep;
  } else if (typeName === PAYLOAD_TYPE.START.name) {
    raw.start = true;
  }

  // Normalize to the shared vocabulary.
  var data = {};

  if (raw.index !== undefined && raw.index !== null && raw.index >= 0) {
    data.metering = { energy: { total: raw.index } }; // Wh
  }

  if (raw.powers && raw.powers.length) {
    var latest = null;
    var i;
    for (i = raw.powers.length - 1; i >= 0; i--) {
      if (raw.powers[i] !== null && raw.powers[i] !== undefined) { latest = raw.powers[i]; break; }
    }
    if (latest !== null) { data.power = { active: latest }; }
    data.powers = raw.powers;
    data.increments = raw.increments;
  }

  data.messageType = raw.messageType;
  if (raw.timeStep !== undefined) { data.timeStep = raw.timeStep; }
  if (raw.meterType !== undefined) { data.meterType = raw.meterType; }
  if (raw.firmwareVersion !== undefined) { data.firmwareVersion = raw.firmwareVersion; }
  if (raw.lowBattery !== undefined) { data.lowBattery = raw.lowBattery; }
  if (raw.numberOfStarts !== undefined) { data.numberOfStarts = raw.numberOfStarts; }
  if (raw.start !== undefined) { data.start = raw.start; }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "fludia";
    result.data.model = "fm432ir-10-15mn";
  }
  return result;
}
