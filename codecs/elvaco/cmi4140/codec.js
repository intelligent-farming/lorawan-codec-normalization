// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elvaco/cmi4140 (CMi4140 Heat Meter
// Connectivity Module for Kamstrup Multical 403/603/803).
//
// Decode logic ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elvaco/cmi4140.js, attributed in
// NOTICE). The wire format is M-Bus style DIF/VIF records carried in an
// Elvaco "standard" frame (first byte 0x15). Normalization to the shared
// vocabulary is authored here; upstream normalization is not copied.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// DIF (hex string) -> VIF (hex string) -> { measure, hasUnit, decimal }.
// hasUnit mirrors the upstream "unit ? scaled : raw integer" branch: records
// with a unit are scaled by 10^-decimal; unitless records are raw integers.
function difVifMapping() {
  return {
    '04': {
      '00': { measure: 'energy', hasUnit: true, decimal: 6 },
      '01': { measure: 'energy', hasUnit: true, decimal: 5 },
      '02': { measure: 'energy', hasUnit: true, decimal: 4 },
      '03': { measure: 'energy', hasUnit: true, decimal: 3 },
      '04': { measure: 'energy', hasUnit: true, decimal: 2 },
      '05': { measure: 'energy', hasUnit: true, decimal: 1 },
      '06': { measure: 'energy', hasUnit: true, decimal: 0 },
      '07': { measure: 'energy', hasUnit: true, decimal: -1 },
      '10': { measure: 'volume', hasUnit: true, decimal: 6 },
      '11': { measure: 'volume', hasUnit: true, decimal: 5 },
      '12': { measure: 'volume', hasUnit: true, decimal: 4 },
      '13': { measure: 'volume', hasUnit: true, decimal: 3 },
      '14': { measure: 'volume', hasUnit: true, decimal: 2 },
      '15': { measure: 'volume', hasUnit: true, decimal: 1 },
      '16': { measure: 'volume', hasUnit: true, decimal: 0 },
      '17': { measure: 'volume', hasUnit: true, decimal: -1 },
      'fd17': { measure: 'error_flag', hasUnit: false, decimal: 0 },
      '6d': { measure: 'datetime_heat_meter', hasUnit: false, decimal: 0 }
    },
    '02': {
      '29': { measure: 'power', hasUnit: true, decimal: 5 },
      '2a': { measure: 'power', hasUnit: true, decimal: 4 },
      '2b': { measure: 'power', hasUnit: true, decimal: 3 },
      '2c': { measure: 'power', hasUnit: true, decimal: 2 },
      '2d': { measure: 'power', hasUnit: true, decimal: 1 },
      '2e': { measure: 'power', hasUnit: true, decimal: 0 },
      '2f': { measure: 'power', hasUnit: true, decimal: -1 },
      '39': { measure: 'flow', hasUnit: true, decimal: 5 },
      '3a': { measure: 'flow', hasUnit: true, decimal: 4 },
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
      'fd17': { measure: 'error_flag', hasUnit: false, decimal: 0 }
    },
    '0c': {
      '78': { measure: 'serial', hasUnit: false, decimal: 0 }
    }
  };
}

function bytesToHexArray(bytes) {
  var out = [];
  var i;
  for (i = 0; i < bytes.length; i++) {
    out.push(('0' + (bytes[i] & 0xff).toString(16)).slice(-2));
  }
  return out;
}

// Returns [vif, nextIndex]. DIF 0x84 (132) flags a two-byte extended VIF.
function getVif(payloadArr, index) {
  var dif = payloadArr[index].toLowerCase();
  var difInt = parseInt(dif, 16);
  if (difInt === 132) {
    var vif = payloadArr.slice(index + 1, index + 3).join('').toLowerCase();
    return [vif, index + 3];
  }
  return [payloadArr[index + 1].toLowerCase(), index + 2];
}

function decodeStandard(payloadArr) {
  var decoded = {};
  var difMap = difVifMapping();
  var i = 1;
  while (i < payloadArr.length) {
    var dif = payloadArr[i].toLowerCase();
    var difInt = parseInt(dif, 16);
    var pair = getVif(payloadArr, i);
    var vif = pair[0];
    i = pair[1];
    var bcdLen = (difInt >= 2 && difInt <= 4) ? difInt : 4;
    if (payloadArr.slice(i).length <= 5 && vif === 'fd') {
      vif += payloadArr[i];
      i += 1;
    }
    if (!(dif in difMap) || !(vif in difMap[dif])) {
      throw new Error('Unknown dif ' + dif + ' and vif ' + vif);
    }
    // Little-endian: reverse the value bytes before parsing.
    var reversed = payloadArr.slice(i, i + bcdLen).reverse().join('');
    i += bcdLen;
    var info = difMap[dif][vif];
    var value;
    if (info.hasUnit) {
      value = parseInt(reversed, 16) / Math.pow(10, info.decimal);
    } else {
      // Faithful to upstream: unitless records parse the reversed hex
      // digit-string as a base-10 number (BCD-style), not base 16.
      value = parseInt(reversed, 10);
    }
    decoded[info.measure] = value;
  }
  return decoded;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }
  var hexArr = bytesToHexArray(input.bytes);
  if (hexArr.length < 40) {
    return { errors: ['payload length < 40'] };
  }
  if (hexArr[0] !== '15') {
    return { errors: ['Payload type unknown, currently standard format supported'] };
  }

  var raw;
  try {
    raw = decodeStandard(hexArr);
  } catch (e) {
    return { errors: [e.message] };
  }

  var data = {};

  // energy: upstream kWh -> metering.energy.total (Wh).
  if (typeof raw.energy === 'number') {
    data.metering = data.metering || {};
    data.metering.energy = { total: round(raw.energy * 1000, 3) };
  }
  // volume: upstream m3 -> metering.water.total (L).
  if (typeof raw.volume === 'number') {
    data.metering = data.metering || {};
    data.metering.water = { total: round(raw.volume * 1000, 3) };
  }
  // power: upstream kW -> power.active (W).
  if (typeof raw.power === 'number') {
    data.power = data.power || {};
    data.power.active = round(raw.power * 1000, 3);
  }
  // flow_temperature: supply-side water temperature (degC).
  if (typeof raw.flow_temperature === 'number') {
    data.water = data.water || {};
    data.water.temperature = { current: round(raw.flow_temperature, 2) };
  }

  // Heat-meter-specific fields with no vocabulary key become camelCase extras.
  if (typeof raw.return_temperature === 'number') {
    data.returnTemperature = round(raw.return_temperature, 2);
  }
  if (typeof raw.flow === 'number') {
    data.flowRate = round(raw.flow, 3);
  }
  if (typeof raw.serial === 'number') {
    data.serialNumber = raw.serial;
  }
  if (typeof raw.error_flag === 'number') {
    data.errorFlag = raw.error_flag;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elvaco";
    result.data.model = "cmi4140";
  }
  return result;
}
