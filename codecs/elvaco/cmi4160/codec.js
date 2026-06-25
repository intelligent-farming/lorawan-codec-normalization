// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elvaco/cmi4160 (Elvaco CMi4160 LoRaWAN module for
// heat / cooling / heat-energy meters — Kamstrup MULTICAL host meter, "standard"
// preconfigured M-Bus message on fPort 2).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/elvaco/cmi4160.js, attributed in
// NOTICE). The fPort/header gate, the DIF/VIF lookup table, the per-record
// little-endian (LSB-first) hex assembly, the per-DIF data-field length rule
// (1-4 / 7 bytes), the VIF-driven decimal scaling and the trailing fd17 error
// flag handling below mirror the upstream parser faithfully. The normalization
// to the shared vocabulary is authored here; the upstream output shape is NOT
// copied.
//
// Wire format (fPort 2, "standard" format): byte 0 must be 0x1e. The remaining
// bytes are a sequence of M-Bus data records: DIF, VIF, then N little-endian data
// bytes. N = 4 by default, or N = DIF when DIF is in {2,3,4,7}. The VIF selects
// the measure and the decimal exponent; value = LE-integer / 10^decimal. The
// final record is the 4-byte error flag (DIF 0x04, VIF 0xfd 0x17). The serial
// record (DIF 0x07, VIF 0x79) carries an extra trailing byte.
//
// Normalization (shared vocabulary):
//   energy  (kWh)  -> metering.energy.total (Wh; kWh x 1000)
//   power   (kW)   -> power.active          (W;  kW  x 1000)
//   volume  (m3)   -> metering.water.total  (L;  m3  x 1000)
// Heat-meter-specific fields with no vocabulary key become camelCase extras:
//   flow (m3/h) -> flow, flow_temperature (C) -> flowTemperature,
//   return_temperature (C) -> returnTemperature, serial -> serial,
//   error flag -> errorFlag.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// DIF -> VIF -> { measure, hasUnit, decimal }. hasUnit=false means the raw
// integer is taken as-is (no scaling). Mirrors the upstream difVifMapping.
var DIF_VIF = {
  '00': { '2f': { measure: '', hasUnit: false, decimal: 0 } },
  '01': { fd17: { measure: 'error_flag', hasUnit: false, decimal: 0 } },
  '04': {
    '00': { measure: 'energy', hasUnit: true, decimal: 6 },
    '01': { measure: 'energy', hasUnit: true, decimal: 5 },
    '02': { measure: 'energy', hasUnit: true, decimal: 4 },
    '03': { measure: 'energy', hasUnit: true, decimal: 3 },
    '04': { measure: 'energy', hasUnit: true, decimal: 2 },
    '05': { measure: 'energy', hasUnit: true, decimal: 1 },
    '06': { measure: 'energy', hasUnit: true, decimal: 0 },
    '07': { measure: 'energy', hasUnit: true, decimal: -1 },
    '11': { measure: 'volume', hasUnit: true, decimal: 5 },
    '12': { measure: 'volume', hasUnit: true, decimal: 4 },
    '13': { measure: 'volume', hasUnit: true, decimal: 3 },
    '14': { measure: 'volume', hasUnit: true, decimal: 2 },
    '15': { measure: 'volume', hasUnit: true, decimal: 1 },
    '16': { measure: 'volume', hasUnit: true, decimal: 0 },
    '17': { measure: 'volume', hasUnit: true, decimal: -1 },
    '6d': { measure: 'datetime_heat_meter', hasUnit: false, decimal: 0 },
    fd17: { measure: 'error_flag', hasUnit: false, decimal: 0 }
  },
  '02': {
    '2a': { measure: 'power', hasUnit: true, decimal: 4 },
    '2b': { measure: 'power', hasUnit: true, decimal: 3 },
    '2c': { measure: 'power', hasUnit: true, decimal: 2 },
    '2d': { measure: 'power', hasUnit: true, decimal: 1 },
    '2e': { measure: 'power', hasUnit: true, decimal: 0 },
    '2f': { measure: 'power', hasUnit: true, decimal: -1 },
    '3b': { measure: 'flow', hasUnit: true, decimal: 3 },
    '3c': { measure: 'flow', hasUnit: true, decimal: 2 },
    '3d': { measure: 'flow', hasUnit: true, decimal: 1 },
    '3e': { measure: 'flow', hasUnit: true, decimal: 0 },
    '3f': { measure: 'flow', hasUnit: true, decimal: -1 },
    '58': { measure: 'flow_temperature', hasUnit: true, decimal: 3 },
    '59': { measure: 'flow_temperature', hasUnit: true, decimal: 2 },
    '5a': { measure: 'flow_temperature', hasUnit: true, decimal: 1 },
    '5b': { measure: 'flow_temperature', hasUnit: true, decimal: 0 },
    '5c': { measure: 'return_temperature', hasUnit: true, decimal: 3 },
    '5d': { measure: 'return_temperature', hasUnit: true, decimal: 2 },
    '5e': { measure: 'return_temperature', hasUnit: true, decimal: 1 },
    '5f': { measure: 'return_temperature', hasUnit: true, decimal: 0 },
    fd17: { measure: 'error_flag', hasUnit: false, decimal: 0 }
  },
  '07': { '79': { measure: 'serial', hasUnit: false, decimal: 0 } }
};

function toHexByte(b) {
  return ('0' + (b & 0xff).toString(16)).slice(-2);
}

// Decode the "standard" format byte array (hex strings) into the upstream
// measure -> value dictionary. Throws a string on an unknown DIF/VIF (caught by
// the caller and surfaced as an error).
function decodeStandard(hexArr) {
  var dict = {};
  var i = 1;
  while (i < hexArr.length) {
    var dif = hexArr[i];
    var difInt = parseInt(dif, 16);
    var vif = hexArr[i + 1];
    i += 2;

    if (hexArr.length - i <= 3 && vif === 'fd') {
      // end of payload: fd17 error flag spread over two VIF bytes
      vif += hexArr[i];
      i += 1;
    }

    var bcdLen = 4;
    if ((difInt >= 2 && difInt <= 4) || difInt === 7) {
      bcdLen = difInt;
    }

    if (!(DIF_VIF[dif] && DIF_VIF[dif][vif])) {
      throw 'Unknown DIF ' + dif + ' / VIF ' + vif;
    }

    var reversed = hexArr.slice(i, i + bcdLen).reverse().join(''); // little-endian
    i += bcdLen;
    var info = DIF_VIF[dif][vif];
    var value;
    if (info.hasUnit) {
      value = parseInt(reversed, 16) / Math.pow(10, info.decimal);
    } else if (info.measure === 'serial') {
      value = parseInt(reversed.slice(-8), 10); // bytes 2-5 hold the serial
      i += 1; // serial record carries one extra trailing byte
    } else {
      value = parseInt(reversed, 16);
    }
    dict[info.measure] = value;
  }
  return dict;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }
  var bytes = input.bytes;
  if (!bytes || bytes.length < 40) {
    return { errors: ['payload length < 40'] };
  }
  var hexArr = [];
  var k;
  for (k = 0; k < bytes.length; k++) {
    hexArr.push(toHexByte(bytes[k]));
  }
  if (hexArr[0] !== '1e') {
    return { errors: ['Payload type unknown, only standard format (0x1e) supported'] };
  }

  var dict;
  try {
    dict = decodeStandard(hexArr);
  } catch (e) {
    return { errors: [String(e)] };
  }

  var out = {};

  // energy kWh -> metering.energy.total Wh
  if (typeof dict.energy === 'number') {
    out.metering = out.metering || {};
    out.metering.energy = { total: round(dict.energy * 1000, 3) };
  }
  // volume m3 -> metering.water.total L
  if (typeof dict.volume === 'number') {
    out.metering = out.metering || {};
    out.metering.water = { total: round(dict.volume * 1000, 3) };
  }
  // power kW -> power.active W
  if (typeof dict.power === 'number') {
    out.power = { active: round(dict.power * 1000, 3) };
  }

  // Heat-meter-specific extras (no vocabulary key).
  if (typeof dict.flow === 'number') {
    out.flow = round(dict.flow, 6);
  }
  if (typeof dict.flow_temperature === 'number') {
    out.flowTemperature = round(dict.flow_temperature, 3);
  }
  if (typeof dict.return_temperature === 'number') {
    out.returnTemperature = round(dict.return_temperature, 3);
  }
  if (typeof dict.serial === 'number') {
    out.serial = dict.serial;
  }
  if (typeof dict.error_flag === 'number') {
    out.errorFlag = dict.error_flag;
  }

  return { data: out };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elvaco";
    result.data.model = "cmi4160";
  }
  return result;
}
