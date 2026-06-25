// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elvaco/cmi4111 (CMi4110 connectivity module for
// the Landis+Gyr T230 heat meter).
//
// decodeUplink ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elvaco/cmi4111.js, attributed in
// NOTICE). The DIF/VIF wire-format parsing below mirrors that reference; the
// normalization to vocabulary keys is authored here, not copied from upstream.

// DIF/VIF -> measure + base unit + decimal-exponent table (mirrors upstream).
var DIF_VIF_MAPPING = {
  '04': {
    '00': { measure: 'energy', unit: 'kWh', decimal: 6 },
    '01': { measure: 'energy', unit: 'kWh', decimal: 5 },
    '02': { measure: 'energy', unit: 'kWh', decimal: 4 },
    '03': { measure: 'energy', unit: 'kWh', decimal: 3 },
    '04': { measure: 'energy', unit: 'kWh', decimal: 2 },
    '05': { measure: 'energy', unit: 'kWh', decimal: 1 },
    '06': { measure: 'energy', unit: 'kWh', decimal: 0 },
    '07': { measure: 'energy', unit: 'kWh', decimal: -1 },
    '10': { measure: 'volume', unit: 'm3', decimal: 6 },
    '11': { measure: 'volume', unit: 'm3', decimal: 5 },
    '12': { measure: 'volume', unit: 'm3', decimal: 4 },
    '13': { measure: 'volume', unit: 'm3', decimal: 3 },
    '14': { measure: 'volume', unit: 'm3', decimal: 2 },
    '15': { measure: 'volume', unit: 'm3', decimal: 1 },
    '16': { measure: 'volume', unit: 'm3', decimal: 0 },
    '17': { measure: 'volume', unit: 'm3', decimal: -1 },
    'fd17': { measure: 'error_flag', unit: '', decimal: 0 },
    '6d': { measure: 'datetime_heat_meter', unit: '', decimal: 0 }
  },
  '02': {
    '29': { measure: 'power', unit: 'kW', decimal: 5 },
    '2a': { measure: 'power', unit: 'kW', decimal: 4 },
    '2b': { measure: 'power', unit: 'kW', decimal: 3 },
    '2c': { measure: 'power', unit: 'kW', decimal: 2 },
    '2d': { measure: 'power', unit: 'kW', decimal: 1 },
    '2e': { measure: 'power', unit: 'kW', decimal: 0 },
    '2f': { measure: 'power', unit: 'kW', decimal: -1 },
    '39': { measure: 'flow', unit: 'm3/h', decimal: 5 },
    '3a': { measure: 'flow', unit: 'm3/h', decimal: 4 },
    '3b': { measure: 'flow', unit: 'm3/h', decimal: 3 },
    '3c': { measure: 'flow', unit: 'm3/h', decimal: 2 },
    '3d': { measure: 'flow', unit: 'm3/h', decimal: 1 },
    '3e': { measure: 'flow', unit: 'm3/h', decimal: 0 },
    '3f': { measure: 'flow', unit: 'm3/h', decimal: -1 },
    '58': { measure: 'flow_temperature', unit: 'C', decimal: 3 },
    '59': { measure: 'flow_temperature', unit: 'C', decimal: 2 },
    '5a': { measure: 'flow_temperature', unit: 'C', decimal: 1 },
    '5b': { measure: 'flow_temperature', unit: 'C', decimal: 0 },
    '5c': { measure: 'return_temperature', unit: 'C', decimal: 3 },
    '5d': { measure: 'return_temperature', unit: 'C', decimal: 2 },
    '5e': { measure: 'return_temperature', unit: 'C', decimal: 1 },
    '5f': { measure: 'return_temperature', unit: 'C', decimal: 0 },
    'fd17': { measure: 'error_flag', unit: '', decimal: 0 }
  },
  '0c': { '78': { measure: 'serial_from_message', unit: '', decimal: 0 } }
};

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bytesToHexArray(bytes) {
  var out = [];
  var i;
  for (i = 0; i < bytes.length; i++) {
    out.push(('0' + (bytes[i] & 0xff).toString(16)).slice(-2));
  }
  return out;
}

// Faithful port of upstream decodeCMI4111Standard: walk DIF/VIF records,
// little-endian values, scaled by the per-record decimal exponent.
function decodeStandard(payloadArr) {
  var decoded = {};
  var i = 1;

  while (i < payloadArr.length) {
    var dif = payloadArr[i];
    var vif = payloadArr[i + 1];
    var difInt = parseInt(dif, 16);
    i += 2;

    if (payloadArr.slice(i).length <= 5 && vif === 'fd') {
      // end of payload: error flag
      vif += payloadArr[i];
      i += 1;
    }

    var bcdLen = difInt >= 2 && difInt <= 4 ? difInt : 4;

    if (dif === '34') {
      if (payloadArr.filter(function (val) { return val === '00'; }).length > 20) {
        throw new Error('Empty payload, value during error state');
      }
      throw new Error('Unknown dif ' + dif + ' and vif ' + vif);
    }

    if (!(dif in DIF_VIF_MAPPING) || !(vif in DIF_VIF_MAPPING[dif])) {
      throw new Error('Unknown dif ' + dif + ' and vif ' + vif);
    }

    var reversedValues = payloadArr.slice(i, i + bcdLen).reverse().join(''); // little-endian
    var unitInfo = DIF_VIF_MAPPING[dif][vif];

    i += bcdLen;
    var value;

    if (unitInfo.measure === 'datetime_heat_meter') {
      throw new Error('datetime_heat_meter is not supported yet');
    } else if (unitInfo.measure === 'serial_from_message') {
      value = parseInt(reversedValues, 10);
    } else if (unitInfo.unit) {
      var valueInt;
      if (reversedValues.indexOf('fff') === 0 && (unitInfo.measure === 'power' || unitInfo.measure === 'flow')) {
        valueInt = parseInt(reversedValues.replace('fff', '-'), 16);
      } else {
        valueInt = parseInt(reversedValues, 16);
      }
      value = valueInt / Math.pow(10, unitInfo.decimal);
    } else {
      value = parseInt(reversedValues, 16);
    }

    decoded[unitInfo.measure] = value;
  }

  return decoded;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }

  var hexArray = bytesToHexArray(input.bytes);

  if (hexArray.length < 40) {
    return { errors: ['payload length < 40'] };
  }
  if (hexArray[0] !== '05') {
    return { errors: ['Payload type unknown, currently standard format supported'] };
  }

  var raw;
  try {
    raw = decodeStandard(hexArray);
  } catch (e) {
    return { errors: [e.message] };
  }

  // Normalize to the shared vocabulary (units authored here, not copied).
  var data = {};

  if (raw.energy !== undefined) {
    // kWh -> Wh
    data['metering'] = data['metering'] || {};
    data.metering.energy = { total: round(raw.energy * 1000, 3) };
  }
  if (raw.volume !== undefined) {
    // m3 -> L (heat-transfer medium volume)
    data['metering'] = data['metering'] || {};
    data.metering.water = { total: round(raw.volume * 1000, 3) };
  }
  if (raw.power !== undefined) {
    // kW -> W
    data['power'] = data['power'] || {};
    data.power.active = round(raw.power * 1000, 3);
  }
  if (raw.flow_temperature !== undefined) {
    // supply (flow) line temperature, deg C
    data['water'] = data['water'] || {};
    data.water.temperature = { current: round(raw.flow_temperature, 3) };
  }

  // Genuine non-vocabulary fields -> camelCase extras.
  if (raw.return_temperature !== undefined) {
    data.returnTemperature = round(raw.return_temperature, 3);
  }
  if (raw.flow !== undefined) {
    data.flowRate = round(raw.flow, 5);
  }
  if (raw.serial_from_message !== undefined) {
    data.serialFromMessage = raw.serial_from_message;
  }
  if (raw.error_flag !== undefined) {
    data.errorFlag = raw.error_flag;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elvaco";
    result.data.model = "cmi4111";
  }
  return result;
}
