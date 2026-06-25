// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elvaco/cmi4130 (Elvaco CMi4130 — LoRaWAN module
// for heat / cooling meters, reporting cumulative energy and water volume plus
// instantaneous power, flow and temperatures over a compact M-Bus-style record
// stream).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/elvaco/cmi4130.js, attributed in
// NOTICE). The fPort/length/header gating and the DIF/VIF record walk
// (decode_cmi4130_standard) below mirror the upstream parser faithfully; the
// normalization to the shared vocabulary is authored here and the upstream
// output shape is NOT copied.
//
// Wire format (fPort 2): byte[0] = 0x0f marks the "standard" format. The rest is
// a sequence of records: DIF byte, VIF byte (possibly the 2-byte extension 0xfd
// 0x17 = error flag at the tail), then a little-endian (LSB-first) integer whose
// length comes from the DIF (2..4 bytes; 0x0c -> 4) and whose decimal exponent
// comes from the DIF/VIF mapping. DIF 0x32 is a reverse-flow record forced to 0
// upstream and reproduced here.
//
// Normalization (shared vocabulary):
//   energy   (kWh)   -> metering.energy.total (Wh; kWh x 1000)
//   power    (kW)    -> power.active          (W;  kW x 1000)
//   volume   (m3)    -> metering.water.total  (L;  m3 x 1000)
//   flow_temperature (C, supply) -> water.temperature.current
// Genuine non-vocabulary fields become camelCase extras:
//   return_temperature -> returnTemperature (C)
//   flow               -> flow              (m3/h)
//   serial             -> serial            (meter serial number)
//   error_flag         -> errorFlag         (raw status bitfield)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// DIF -> VIF -> { measure, decimal }. decimal is the base-10 exponent applied to
// the raw integer (value = raw / 10^decimal).
var DIF_VIF = {
  '04': {
    '00': { measure: 'energy', decimal: 6 },
    '01': { measure: 'energy', decimal: 5 },
    '02': { measure: 'energy', decimal: 4 },
    '03': { measure: 'energy', decimal: 3 },
    '04': { measure: 'energy', decimal: 2 },
    '05': { measure: 'energy', decimal: 1 },
    '06': { measure: 'energy', decimal: 0 },
    '07': { measure: 'energy', decimal: -1 },
    '11': { measure: 'volume', decimal: 5 },
    '12': { measure: 'volume', decimal: 4 },
    '13': { measure: 'volume', decimal: 3 },
    '14': { measure: 'volume', decimal: 2 },
    '15': { measure: 'volume', decimal: 1 },
    '16': { measure: 'volume', decimal: 0 },
    '17': { measure: 'volume', decimal: -1 },
    'fd17': { measure: 'error_flag', decimal: 0 },
    '6d': { measure: 'datetime_heat_meter', decimal: 0 }
  },
  '02': {
    '2a': { measure: 'power', decimal: 4 },
    '2b': { measure: 'power', decimal: 3 },
    '2c': { measure: 'power', decimal: 2 },
    '2d': { measure: 'power', decimal: 1 },
    '2e': { measure: 'power', decimal: 0 },
    '2f': { measure: 'power', decimal: -1 },
    '3b': { measure: 'flow', decimal: 3 },
    '3c': { measure: 'flow', decimal: 2 },
    '3d': { measure: 'flow', decimal: 1 },
    '3e': { measure: 'flow', decimal: 0 },
    '3f': { measure: 'flow', decimal: -1 },
    '58': { measure: 'flow_temperature', decimal: 3 },
    '59': { measure: 'flow_temperature', decimal: 2 },
    '5a': { measure: 'flow_temperature', decimal: 1 },
    '5b': { measure: 'flow_temperature', decimal: 0 },
    '5c': { measure: 'return_temperature', decimal: 3 },
    '5d': { measure: 'return_temperature', decimal: 2 },
    '5e': { measure: 'return_temperature', decimal: 1 },
    '5f': { measure: 'return_temperature', decimal: 0 },
    'fd17': { measure: 'error_flag', decimal: 0 }
  },
  '32': {
    '2a': { measure: 'power', decimal: 4 },
    '2b': { measure: 'power', decimal: 3 },
    '2c': { measure: 'power', decimal: 2 },
    '2d': { measure: 'power', decimal: 1 },
    '2e': { measure: 'power', decimal: 0 },
    '2f': { measure: 'power', decimal: -1 },
    '3b': { measure: 'flow', decimal: 3 },
    '3c': { measure: 'flow', decimal: 2 },
    '3d': { measure: 'flow', decimal: 1 },
    '3e': { measure: 'flow', decimal: 0 },
    '3f': { measure: 'flow', decimal: -1 }
  },
  '0c': { '78': { measure: 'serial', decimal: 0 } }
};

function hex2(b) {
  return ('0' + (b & 0xff).toString(16)).slice(-2);
}

function bytesToHexArray(bytes) {
  var out = [];
  var i;
  for (i = 0; i < bytes.length; i++) {
    out.push(hex2(bytes[i]));
  }
  return out;
}

// Walk the DIF/VIF record stream (mirrors upstream decode_cmi4130_standard).
// Returns { fields: {...} } on success or { error: '...' } on an unknown record.
function walkRecords(hex) {
  var fields = {};
  var i = 1;
  while (i < hex.length) {
    var dif = hex[i].toLowerCase();
    var difInt = parseInt(dif, 16);
    var vif = hex[i + 1].toLowerCase();
    i += 2;

    // Tail error-flag extension: 0xfd 0x17.
    if (hex.length - i <= 3 && vif === 'fd') {
      vif += hex[i];
      i += 1;
    }

    var bcdLen = 4;
    if (difInt >= 2 && difInt <= 4) {
      bcdLen = difInt;
    } else if (difInt === 50) {
      // DIF 0x32 (reverse flow) carries a 2-byte value.
      bcdLen = 2;
    }

    if (!(DIF_VIF.hasOwnProperty(dif) && DIF_VIF[dif].hasOwnProperty(vif))) {
      return { error: 'Unknown dif ' + dif + ' and vif ' + vif };
    }

    // Little-endian integer: reverse the byte slice, concatenate, parse base 16.
    var slice = hex.slice(i, i + bcdLen);
    var rev = '';
    var j;
    for (j = slice.length - 1; j >= 0; j--) {
      rev += slice[j];
    }
    i += bcdLen;

    var info = DIF_VIF[dif][vif];
    var value = parseInt(rev, 16) / Math.pow(10, info.decimal);
    if (isNaN(value)) {
      value = 0;
    }

    if (dif === '32') {
      // Reverse-flow record: forced to 0 upstream.
      fields[info.measure] = 0;
    } else {
      fields[info.measure] = value;
    }
  }
  return { fields: fields };
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }

  var hex = bytesToHexArray(input.bytes);
  if (hex.length < 40) {
    return { errors: ['payload length < 40'] };
  }
  if (hex[0] !== '0f') {
    return { errors: ['Payload type unknown, currently standard format supported'] };
  }

  var walked = walkRecords(hex);
  if (walked.error) {
    return { errors: [walked.error] };
  }
  var f = walked.fields;

  var data = {};

  // metering.energy.total — Wh (kWh x 1000).
  if (f.hasOwnProperty('energy')) {
    data['metering.energy.total'] = round(f.energy * 1000, 3);
  }
  // metering.water.total — L (m^3 x 1000).
  if (f.hasOwnProperty('volume')) {
    data['metering.water.total'] = round(f.volume * 1000, 3);
  }
  // power.active — W (kW x 1000).
  if (f.hasOwnProperty('power')) {
    data['power.active'] = round(f.power * 1000, 3);
  }
  // water.temperature.current — supply (flow) temperature, C.
  if (f.hasOwnProperty('flow_temperature')) {
    data['water.temperature.current'] = round(f.flow_temperature, 3);
  }

  // Genuine non-vocabulary fields -> camelCase extras.
  if (f.hasOwnProperty('return_temperature')) {
    data.returnTemperature = round(f.return_temperature, 3);
  }
  if (f.hasOwnProperty('flow')) {
    data.flow = round(f.flow, 3);
  }
  if (f.hasOwnProperty('serial')) {
    data.serial = f.serial;
  }
  if (f.hasOwnProperty('error_flag')) {
    data.errorFlag = f.error_flag;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elvaco";
    result.data.model = "cmi4130";
  }
  return result;
}
