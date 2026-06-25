// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elvaco/cmi4110 (CMi4110 connectivity module for
// Landis+Gyr UH50/T230-class heat meters).
//
// decodeUplink ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elvaco/cmi4110.js, attributed in
// NOTICE). Unlike the binary little-endian cmi4111 sibling, this wire format is
// BCD: each DIF/VIF record's value bytes are reversed and read as decimal digits
// (the upstream parseInt without a radix). The DIF/VIF table, the extended-VIF
// (0x84) handling, the end-of-payload VIF extension, and the split where only
// 'flow' uses the binary value (with the f0 negative-sign convention) are
// reproduced faithfully; the mapping to vocabulary keys is authored here, not
// copied from upstream normalizeUplink.

var DIF_VIF_MAPPING = {
  '0c': {
    '06': { measure: 'energy', unit: 'kWh', decimal: 0 },
    '07': { measure: 'energy', unit: 'kWh', decimal: -1 },
    '14': { measure: 'volume', unit: 'm3', decimal: 2 },
    '15': { measure: 'volume', unit: 'm3', decimal: 1 },
    '16': { measure: 'volume', unit: 'm3', decimal: 0 },
    '78': { measure: 'serial', unit: '', decimal: 0 }
  },
  '0b': {
    '2a': { measure: 'power', unit: 'kW', decimal: 4 },
    '2b': { measure: 'power', unit: 'kW', decimal: 3 },
    '2c': { measure: 'power', unit: 'kW', decimal: 2 },
    '2d': { measure: 'power', unit: 'kW', decimal: 1 },
    '2e': { measure: 'power', unit: 'kW', decimal: 0 },
    '2f': { measure: 'power', unit: 'kW', decimal: -1 },
    '3b': { measure: 'flow', unit: 'm3/h', decimal: 3 },
    '3c': { measure: 'flow', unit: 'm3/h', decimal: 2 },
    '3d': { measure: 'flow', unit: 'm3/h', decimal: 1 },
    '3e': { measure: 'flow', unit: 'm3/h', decimal: 0 },
    '3f': { measure: 'flow', unit: 'm3/h', decimal: -1 }
  },
  '0a': {
    '5a': { measure: 'flow_temperature', unit: 'C', decimal: 1 },
    '5b': { measure: 'flow_temperature', unit: 'C', decimal: 0 },
    '5e': { measure: 'return_temperature', unit: 'C', decimal: 1 },
    '5f': { measure: 'return_temperature', unit: 'C', decimal: 0 }
  },
  '02': { fd17: { measure: 'error_flag', unit: '', decimal: 0 } },
  '04': { fd17: { measure: 'error_flag', unit: '', decimal: 0 } }
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

// Extended VIF: DIF 0x84 carries a 2-byte VIF; otherwise a 1-byte VIF.
function getVif(payloadArr, index) {
  var difInt = parseInt(payloadArr[index], 16);
  if (difInt === 132) {
    return [payloadArr.slice(index + 1, index + 3).join('').toLowerCase(), index + 3];
  }
  return [payloadArr[index + 1].toLowerCase(), index + 2];
}

// 'flow' reads the reversed bytes as binary, with an f0 negative-sign convention.
function checkNegativeValue(reversedValues) {
  if (reversedValues.indexOf('f0') !== -1) {
    return -parseInt(reversedValues.replace('f0', ''), 16);
  }
  return parseInt(reversedValues, 16);
}

// Faithful port of upstream decodeCMI4110Standard.
function decodeStandard(payloadArr) {
  var decoded = {};
  var i = 1;
  var energyCount = 0;

  while (i < payloadArr.length) {
    var dif = payloadArr[i].toLowerCase();
    var difInt = parseInt(dif, 16);
    var g = getVif(payloadArr, i);
    var vif = g[0];
    i = g[1];

    var bcdLen = difInt;
    if (!(difInt >= 2 && difInt <= 4)) {
      bcdLen = difInt - 8;
    }
    if (payloadArr.length - i <= 3) {
      vif += payloadArr[i];
      i += 1;
    }

    if (DIF_VIF_MAPPING[dif] && DIF_VIF_MAPPING[dif][vif]) {
      var reversedValues = payloadArr.slice(i, i + bcdLen).reverse().join('');
      var valueInt = checkNegativeValue(reversedValues);
      i += bcdLen;

      var unitInfo = DIF_VIF_MAPPING[dif][vif];
      var register = unitInfo.measure;
      var value;

      if (register === 'energy') {
        if (energyCount !== 0) {
          if (energyCount < 4) {
            register = 'energy_tariff_' + energyCount;
          } else {
            throw new Error('more than 4 energy registers');
          }
        }
        energyCount += 1;
        value = parseInt(reversedValues, 10) / Math.pow(10, unitInfo.decimal);
      } else if (register === 'flow') {
        value = valueInt / Math.pow(10, unitInfo.decimal);
      } else {
        value = parseInt(reversedValues, 10) / Math.pow(10, unitInfo.decimal);
        if (!unitInfo.unit) {
          value = parseInt(reversedValues, 10);
        }
      }
      decoded[register] = value;
    } else {
      throw new Error('Unknown dif ' + dif + ' and vif ' + vif);
    }
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
  if (hexArray[0] !== '00') {
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
    data.metering = data.metering || {};
    data.metering.energy = { total: round(raw.energy * 1000, 3) }; // kWh -> Wh
  }
  if (raw.volume !== undefined) {
    data.metering = data.metering || {};
    data.metering.water = { total: round(raw.volume * 1000, 3) }; // m3 -> L
  }
  if (raw.power !== undefined) {
    data.power = data.power || {};
    data.power.active = round(raw.power * 1000, 3); // kW -> W
  }
  if (raw.flow_temperature !== undefined) {
    data.water = data.water || {};
    data.water.temperature = { current: round(raw.flow_temperature, 3) };
  }

  // Genuine non-vocabulary fields -> camelCase extras.
  if (raw.return_temperature !== undefined) {
    data.returnTemperature = round(raw.return_temperature, 3);
  }
  if (raw.flow !== undefined) {
    data.flowRate = round(raw.flow, 5);
  }
  if (raw.serial !== undefined) {
    data.serialFromMessage = raw.serial;
  }
  if (raw.error_flag !== undefined) {
    data.errorFlag = raw.error_flag;
  }
  if (raw.energy_tariff_1 !== undefined) {
    data.energyTariff1 = round(raw.energy_tariff_1 * 1000, 3);
  }
  if (raw.energy_tariff_2 !== undefined) {
    data.energyTariff2 = round(raw.energy_tariff_2 * 1000, 3);
  }
  if (raw.energy_tariff_3 !== undefined) {
    data.energyTariff3 = round(raw.energy_tariff_3 * 1000, 3);
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elvaco";
    result.data.model = "cmi4110";
  }
  return result;
}
