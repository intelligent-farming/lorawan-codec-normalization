// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for YOBIIQ iQ RM200 (P1002003, "iQ Digital
// Controller") — a 2-channel digital-output relay/controller module that also
// exposes ambient and internal-circuit temperature/humidity diagnostics.
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/yobiiq/iq-rm200-lrw.js, "YOBIIQ JS
// payload decoder/encoder", v2.0.0, attributed in NOTICE). The upstream
// channel/type register-walk decode is reproduced faithfully; only the OUTPUT
// is renormalized to the shared vocabulary. Upstream's normalizeUplink was NOT
// copied.
//
// Normalization notes:
//   * ambientTemperature (0x82) -> air.temperature, ambientHumidity (0x83) ->
//     air.relativeHumidity. These are the only genuine environmental readings.
//   * internalCircuitTemperature/internalCircuitHumidity are device-health PCB
//     diagnostics, NOT ambient climate, so they are kept as camelCase extras
//     and deliberately NOT mapped into air.*.
//   * batteryVoltage (0x6C) is volts -> `battery`; batteryPercentage (0x6D) is
//     a percentage -> the camelCase extra `batteryPercent` (vocabulary
//     `battery` is volts).
//   * The device reports no CO2, so this codec only ever satisfies `climate`.
//   * Upstream's constant identity fields (codecVersion / genericModel /
//     productCode / manufacturer) are not telemetry and are omitted.
//   * Every other genuine device field (relay channel state/control/counters,
//     button-override status, timestamps, version strings, status flags) is
//     preserved as a camelCase extra under its upstream name.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var GENERIC_CHANNEL = 0xff;
var DEVICE_CHANNEL = 0x01;
var ALARM_CHANNEL = 0xaa;
var PARAMETER_CHANNEL = 0xff;

var ERR_CHANNEL = 'Unknown channel ';
var ERR_TYPE = 'Unknown type ';
var ERR_FPORT = 'Incorrect fPort';

var COMMON_REGISTERS = {
  '0xFE': { SIZE: 4, NAME: 'timestamp' },
  '0x01': { SIZE: 4, NAME: 'dataloggerTimestamp' }
};

var DEVICE_GENERIC_REGISTERS = {
  '0x64': { SIZE: 1, NAME: 'deviceStatus', VALUES: { '0x00': 'NORMAL MODE', '0x01': 'BUTTON MODE' } },
  '0x65': { SIZE: 0, NAME: 'manufacturerName' },
  '0x66': { SIZE: 0, NAME: 'originalEquipmentManufacturer' },
  '0x67': { SIZE: 0, NAME: 'deviceModel' },
  '0x68': { SIZE: 4, NAME: 'deviceSerialNumber' },
  '0x69': { SIZE: 2, NAME: 'firmwareVersion', DIGIT: false },
  '0x6A': { SIZE: 2, NAME: 'hardwareVersion', DIGIT: false },
  '0x6B': { SIZE: 1, NAME: 'externalPowerStatus', VALUES: { '0x00': 'AC POWER OFF', '0x01': 'AC POWER ON' } },
  '0x6C': { SIZE: 1, NAME: 'batteryVoltage', RESOLUTION: 0.1 },
  '0x6D': { SIZE: 1, NAME: 'batteryPercentage' },
  '0x78': { SIZE: 1, NAME: 'internalCircuitTemperatureAlarm', VALUES: { '0x00': 'NORMAL', '0x01': 'ALARM' } },
  '0x79': { SIZE: 4, NAME: 'internalCircuitTemperatureNumberOfAlarms' },
  '0x7A': { SIZE: 2, NAME: 'internalCircuitTemperature', RESOLUTION: 0.01, SIGNED: true },
  '0x7B': { SIZE: 1, NAME: 'internalCircuitHumidity' },
  '0x82': { SIZE: 2, NAME: 'ambientTemperature', RESOLUTION: 0.01, SIGNED: true },
  '0x83': { SIZE: 1, NAME: 'ambientHumidity' },
  '0x96': { SIZE: 1, NAME: 'joinStatus', VALUES: { '0x00': 'OFFLINE', '0x01': 'ONLINE' } },
  '0x9D': { SIZE: 1, NAME: 'applicationPort' },
  '0x9E': { SIZE: 1, NAME: 'joinType', VALUES: { '0x01': 'OTAA' } },
  '0x9F': { SIZE: 1, NAME: 'deviceClass', VALUES: { '0x00': 'CLASS A', '0x01': 'CLASS B', '0x02': 'CLASS C' } },
  '0xA0': { SIZE: 1, NAME: 'adr', VALUES: { '0x00': 'DISABLED', '0x01': 'ENABLED' } },
  '0xA1': { SIZE: 1, NAME: 'sf', VALUES: { '0x00': 'SF12BW125', '0x01': 'SF11BW125', '0x02': 'SF10BW125', '0x03': 'SF9BW125', '0x04': 'SF8BW125', '0x05': 'SF7BW125', '0x06': 'SF7BW250' } },
  '0xA3': { SIZE: 1, NAME: 'radioMode', VALUES: { '0x00': 'LoRaWAN', '0x01': 'iQ D2D', '0x02': 'LoRaWAN & iQ D2D' } },
  '0xA4': { SIZE: 1, NAME: 'numberOfJoinAttempts' },
  '0xA5': { SIZE: 2, NAME: 'linkCheckTimeframe' },
  '0xA6': { SIZE: 1, NAME: 'dataRetransmission', VALUES: { '0x00': 'DISABLED', '0x01': 'ENABLED' } },
  '0xA7': { SIZE: 1, NAME: 'lorawanWatchdogAlarm', VALUES: { '0x00': 'NORMAL', '0x01': 'ALARM' } }
};

var DEVICE_SPECIFIC_REGISTERS = {
  '0x1A': { SIZE: 1, NAME: 'channel1State', VALUES: { '0x00': 'OFF', '0x01': 'ON' } },
  '0x1B': { SIZE: 1, NAME: 'channel1Control', VALUES: { '0x00': 'OFF', '0x01': 'ON' } },
  '0x1C': { SIZE: 4, NAME: 'channel1Counter' },
  '0x1D': { SIZE: 1, NAME: 'channel1DefaultState', VALUES: { '0x00': 'OFF', '0x01': 'ON', '0x02': 'RETAIN' } },
  '0x1E': { SIZE: 1, NAME: 'channel1WatchdogState', VALUES: { '0x00': 'OFF', '0x01': 'ON', '0x02': 'RETAIN' } },
  '0x1F': { SIZE: 1, NAME: 'channel1ButtonOverrideFunction', VALUES: { '0x00': 'DISABLED', '0x01': 'ENABLED' } },
  '0x10': { SIZE: 1, NAME: 'channel1ButtonOverrideStatus', VALUES: { '0x00': 'NORMAL MODE', '0x01': 'MANUAL ON', '0x02': 'MANUAL OFF' } },
  '0x2A': { SIZE: 1, NAME: 'channel2State', VALUES: { '0x00': 'OFF', '0x01': 'ON' } },
  '0x2B': { SIZE: 1, NAME: 'channel2Control', VALUES: { '0x00': 'OFF', '0x01': 'ON' } },
  '0x2C': { SIZE: 4, NAME: 'channel2Counter' },
  '0x2D': { SIZE: 1, NAME: 'channel2DefaultState', VALUES: { '0x00': 'OFF', '0x01': 'ON', '0x02': 'RETAIN' } },
  '0x2E': { SIZE: 1, NAME: 'channel2WatchdogState', VALUES: { '0x00': 'OFF', '0x01': 'ON', '0x02': 'RETAIN' } },
  '0x2F': { SIZE: 1, NAME: 'channel2ButtonOverrideFunction', VALUES: { '0x00': 'DISABLED', '0x01': 'ENABLED' } },
  '0x20': { SIZE: 1, NAME: 'channel2ButtonOverrideStatus', VALUES: { '0x00': 'NORMAL MODE', '0x01': 'MANUAL ON', '0x02': 'MANUAL OFF' } }
};

function toEvenHEX(hex) {
  if (hex.length === 1) {
    return '0' + hex;
  }
  return hex;
}

function byteToEvenHEX(byte) {
  return toEvenHEX(byte.toString(16).toUpperCase());
}

function getStringFromBytesBigEndianFormat(bytes, index, size) {
  var value = '';
  for (var i = 0; i < size; i = i + 1) {
    value = value + String.fromCharCode(bytes[index + i]);
  }
  return value;
}

function getValueFromBytesBigEndianFormat(bytes, index, size) {
  var value = 0;
  for (var i = 0; i < size - 1; i = i + 1) {
    value = (value | bytes[index + i]) << 8;
  }
  value = value | bytes[index + size - 1];
  return value >>> 0;
}

function getDigitStringArrayNoFormat(bytes, index, size) {
  var hexString = [];
  for (var i = 0; i < size; i = i + 1) {
    hexString.push(bytes[index + i].toString(16));
  }
  return hexString;
}

function getSizeBasedOnChannel(bytes, index, channel) {
  var size = 0;
  while (index + size < bytes.length && bytes[index + size] !== channel) {
    size = size + 1;
  }
  return size;
}

function getSignedIntegerFromInteger(integer, size) {
  var signMask = 1 << (size * 8 - 1);
  var dataMask = (1 << (size * 8 - 1)) - 1;
  if (integer & signMask) {
    return -(~integer & dataMask) - 1;
  }
  return integer & dataMask;
}

// Decode a single register's value. Returns { value: <decoded>, size: <bytes consumed> }.
function decodeRegister(bytes, reg, channel, index) {
  var dataSize = reg.SIZE;
  var data;

  if (reg.DIGIT === false) {
    var digits = getDigitStringArrayNoFormat(bytes, index, dataSize);
    data = 'V' + digits[0] + '.' + digits[1];
    return { value: data, size: dataSize };
  }
  if (reg.VALUES) {
    var key = '0x' + byteToEvenHEX(bytes[index]);
    return { value: reg.VALUES[key], size: dataSize };
  }
  if (dataSize === 0) {
    dataSize = getSizeBasedOnChannel(bytes, index, channel);
    data = getStringFromBytesBigEndianFormat(bytes, index, dataSize);
    return { value: data, size: dataSize };
  }
  data = getValueFromBytesBigEndianFormat(bytes, index, dataSize);
  if (reg.SIGNED) {
    data = getSignedIntegerFromInteger(data, dataSize);
  }
  if (reg.RESOLUTION) {
    data = round(data * reg.RESOLUTION, 2);
  }
  return { value: data, size: dataSize };
}

// Walk a channel/type register stream. `expectedChannel` is the required leading
// channel byte; `tables` is the ordered list of register maps to look up types in.
// Returns { raw: {<name>: value}, error: <string|null> }.
function walkRegisters(bytes, expectedChannel, tables) {
  var raw = {};
  var index = 0;
  while (index < bytes.length) {
    var channel = bytes[index];
    index = index + 1;
    if (channel !== expectedChannel) {
      return { raw: raw, error: ERR_CHANNEL + '0x' + byteToEvenHEX(channel) + ' at index ' + (index - 1) };
    }
    var type = '0x' + byteToEvenHEX(bytes[index]);
    index = index + 1;
    var reg = null;
    for (var t = 0; t < tables.length; t = t + 1) {
      if (type in tables[t]) {
        reg = tables[t][type];
        break;
      }
    }
    if (!reg) {
      return { raw: raw, error: ERR_TYPE + type + ' at index ' + (index - 1) };
    }
    var decoded = decodeRegister(bytes, reg, channel, index);
    raw[reg.NAME] = decoded.value;
    index = index + decoded.size;
  }
  return { raw: raw, error: null };
}

// Build the raw upstream-equivalent decode for a given fPort/bytes.
// Returns { raw: <name/value map>, error: <string|null>, info: <string|null>, warning: <string|null>, mac: <bool> }.
function decodeRaw(fPort, bytes) {
  if (fPort === 0) {
    return { raw: {}, error: null, mac: true };
  }
  if (bytes.length === 1) {
    if (bytes[0] === 0) {
      return { raw: {}, info: 'DOWNLINK COMMAND SUCCEEDED' };
    }
    if (bytes[0] === 1) {
      return { raw: {}, warning: 'DOWNLINK COMMAND FAILED' };
    }
    return { raw: {} };
  }
  if (fPort >= 50 && fPort <= 99) {
    return walkRegisters(bytes, GENERIC_CHANNEL, [DEVICE_GENERIC_REGISTERS]);
  }
  if (fPort >= 1 && fPort <= 5) {
    return walkRegisters(bytes, DEVICE_CHANNEL, [DEVICE_SPECIFIC_REGISTERS, DEVICE_GENERIC_REGISTERS, COMMON_REGISTERS]);
  }
  if (fPort === 11) {
    return walkRegisters(bytes, ALARM_CHANNEL, [DEVICE_SPECIFIC_REGISTERS, DEVICE_GENERIC_REGISTERS, COMMON_REGISTERS]);
  }
  if (fPort === 100) {
    return walkRegisters(bytes, PARAMETER_CHANNEL, [DEVICE_SPECIFIC_REGISTERS, DEVICE_GENERIC_REGISTERS]);
  }
  return { raw: {}, error: ERR_FPORT };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  var result = decodeRaw(fPort, bytes);
  if (result.error) {
    return { errors: [result.error] };
  }

  var data = {};
  var air = {};
  var warnings = [];

  if (result.mac) {
    data.mac = 'MAC COMMAND RECEIVED';
  }
  if (result.info) {
    data.downlinkAck = result.info;
  }
  if (result.warning) {
    data.downlinkAck = result.warning;
    warnings.push(result.warning);
  }

  var raw = result.raw;
  for (var name in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) {
      continue;
    }
    var value = raw[name];
    if (name === 'ambientTemperature') {
      air.temperature = value;
    } else if (name === 'ambientHumidity') {
      air.relativeHumidity = value;
    } else if (name === 'batteryVoltage') {
      data.battery = value;
    } else if (name === 'batteryPercentage') {
      data.batteryPercent = value;
    } else {
      // Genuine device data the vocabulary does not model: relay channel
      // state/counters, button overrides, internal-circuit diagnostics,
      // timestamps, radio config, version strings, status flags.
      data[name] = value;
    }
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }

  var out = { data: data };
  if (warnings.length) {
    out.warnings = warnings;
  }
  return out;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "yobiiq";
    result.data.model = "iq-rm200-lrw";
  }
  return result;
}
