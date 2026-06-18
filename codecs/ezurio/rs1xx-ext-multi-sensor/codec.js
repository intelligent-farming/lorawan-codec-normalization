// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Ezurio (Laird) Sentrius RS1xx External Multi
// Sensor. Onboard temperature/humidity sensor plus support for external
// open/closed contact and battery notifications.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Laird message-type framing) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/ezurio/rs1xx-ext-multi-sensor.js, attributed in NOTICE).
//
// Ported faithfully from the upstream `decodeUplink` dispatcher: the upstream
// codec only routes message types 0x01-0x0A; the external RTD/thermistor probe
// types (0x0B/0x0C) are NOT handled upstream and fall through to the "Invalid
// message type used!" error, so this codec reproduces that behavior and emits
// no probe/water temperature (there is no decoded probe reading to map).
//
// Onboard temperature -> air.temperature; humidity -> air.relativeHumidity;
// battery voltage (type 0x0A, already volts) -> `battery`. The string battery
// capacity range (type 0x01/0x02) is NOT a percentage number, so it is kept as
// the camelCase extra `batteryCapacity`. Contact state -> action.contactState.
// All other decoded fields (message type, options, counters, config) are
// emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s8(b) {
  return b > 127 ? b - 256 : b;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32be(b0, b1, b2, b3) {
  return ((b0 * 0x1000000) + (b1 << 16) + (b2 << 8) + b3) >>> 0;
}

// Laird "two bytes to float": [fractional(int8), decimal(int8)] -> decimal + fractional/100.
function pairToFloat(frac, dec) {
  return round(s8(dec) + (s8(frac) / 100.0), 2);
}

var BATTERY_CAPACITY = ['0-5%', '5-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
var BATTERY_TYPE = { 1: 'Alkaline', 2: 'Lithium' };
var BOOLEAN = { 0: 'False', 1: 'True' };
var OPERATING_MODE = { 0: 'Door Sensor', 1: 'Pushbutton' };
var CONTACT_STATE = { 0: 'Closed', 1: 'Open' };
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

var UPLINK_OPTIONS = [
  { bit: 0x01, name: 'Sensor request for server time' },
  { bit: 0x02, name: 'Sensor configuration error' },
  { bit: 0x04, name: 'Sensor alarm flag' },
  { bit: 0x08, name: 'Sensor reset flag' },
  { bit: 0x10, name: 'Sensor fault flag' }
];

var LORA_INDICATION_OPTIONS = [
  { bit: 0x01, name: 'Open' },
  { bit: 0x02, name: 'Closed' },
  { bit: 0x04, name: 'Resend' },
  { bit: 0x08, name: 'Cancel' }
];

function decodeBitfield(table, value) {
  if (value === 0) {
    return ['None'];
  }
  var out = [];
  var i;
  for (i = 0; i < table.length; i++) {
    if ((value & table[i].bit) === table[i].bit) {
      out.push(table[i].name);
      value -= table[i].bit;
    }
  }
  return out;
}

function decodeTimestamp(b0, b1, b2, b3) {
  // Seconds since 2015-01-01, big-endian U32.
  var seconds = u32be(b0, b1, b2, b3);
  var ms = (seconds * 1000) + new Date('2015-01-01').getTime();
  var d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: MONTHS[d.getUTCMonth()],
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds()
  };
}

// --- Message-type decoders (faithful port of upstream) ---

function decodeInternalTH(b) {
  if (b.length !== 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'Laird_Internal_TH',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    batteryCapacity: BATTERY_CAPACITY[b[6]],
    alarmMsgCount: u16be(b[7], b[8]),
    backlogMsgCount: u16be(b[9], b[10]),
    air: {
      relativeHumidity: pairToFloat(b[2], b[3]),
      temperature: pairToFloat(b[4], b[5])
    }
  };
  return { data: data };
}

function decodeAggTH(b) {
  if (b.length <= 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var readingsBytes = b[6] * 4;
  if (b.length !== readingsBytes + 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var i = 11;
  var readings = [];
  var remaining = readingsBytes;
  while (remaining > 0) {
    readings.push({
      relativeHumidity: pairToFloat(b[i], b[i + 1]),
      temperature: pairToFloat(b[i + 2], b[i + 3])
    });
    i += 4;
    remaining -= 4;
  }
  var data = {
    msgType: 'Laird_Agg_TH',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    batteryCapacity: BATTERY_CAPACITY[b[5]],
    alarmMsgCount: b[2],
    backlogMsgCount: u16be(b[3], b[4]),
    numberOfReadings: b[6],
    timestamp: decodeTimestamp(b[7], b[8], b[9], b[10]),
    readings: readings
  };
  if (readings.length > 0) {
    data.air = {
      relativeHumidity: readings[0].relativeHumidity,
      temperature: readings[0].temperature
    };
  }
  return { data: data };
}

function decodeBacklogMessage(b) {
  if (b.length !== 10) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'SendBackLogMessage',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    timestamp: decodeTimestamp(b[2], b[3], b[4], b[5]),
    air: {
      relativeHumidity: pairToFloat(b[6], b[7]),
      temperature: pairToFloat(b[8], b[9])
    }
  };
  return { data: data };
}

function decodeBacklogMessages(b) {
  if (b.length < 11 || (b.length - 3) % 8 !== 0) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var i = 3;
  var readings = [];
  while (i < b.length) {
    readings.push({
      timestamp: decodeTimestamp(b[i], b[i + 1], b[i + 2], b[i + 3]),
      relativeHumidity: pairToFloat(b[i + 4], b[i + 5]),
      temperature: pairToFloat(b[i + 6], b[i + 7])
    });
    i += 8;
  }
  var data = {
    msgType: 'SendBackLogMessages',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    numberOfReadings: b[2],
    readings: readings
  };
  if (readings.length > 0) {
    data.air = {
      relativeHumidity: readings[0].relativeHumidity,
      temperature: readings[0].temperature
    };
  }
  return { data: data };
}

function decodeSimpleConfig(b) {
  if (b.length !== 8) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'Laird_Simple_Config',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    batteryType: BATTERY_TYPE[b[2]],
    sensorReadPeriod: u16be(b[3], b[4]),
    sensorAggregate: b[5],
    tempAlarmsEnabled: BOOLEAN[b[6]],
    humidityAlarmsEnabled: BOOLEAN[b[7]]
  };
  return { data: data };
}

function decodeAdvancedConfig(b) {
  if (b.length !== 16) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'Laird_Advanced_Config',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    batteryType: BATTERY_TYPE[b[2]],
    sensorReadPeriod: u16be(b[3], b[4]),
    sensorAggregate: b[5],
    tempAlarmsEnabled: BOOLEAN[b[6]],
    humidityAlarmsEnabled: BOOLEAN[b[7]],
    tempAlarmLimitLow: s8(b[8]),
    tempAlarmLimitHigh: s8(b[9]),
    humidityAlarmLimitLow: b[10],
    humidityAlarmLimitHigh: b[11],
    ledBle: u16be(b[12], b[13]),
    ledLora: u16be(b[14], b[15])
  };
  return { data: data };
}

function decodeFirmwareVersion(b) {
  if (b.length !== 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'Laird_FW_Version',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    releaseDate: b[2] + '/' + b[3] + '/' + b[4],
    releaseNumber: b[5] + '.' + b[6],
    partNumber: u32be(b[7], b[8], b[9], b[10])
  };
  return { data: data };
}

function decodeContactSensorConfig(b) {
  if (b.length !== 10) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'Laird_Contact_Sensor_Config',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    operatingMode: OPERATING_MODE[b[2]],
    loraNotificationOptions: decodeBitfield(LORA_INDICATION_OPTIONS, b[3]),
    openDwellTime: u16be(b[4], b[5]),
    closedDwellTime: u16be(b[6], b[7]),
    resendInterval: b[8],
    debounceAdjust: b[9]
  };
  return { data: data };
}

function decodeContactSensorState(b) {
  if (b.length !== 6) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'Laird_Contact_Sensor',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    operatingMode: OPERATING_MODE[b[2]],
    alertCancellation: BOOLEAN[b[4]],
    counter: b[5]
  };
  var stateName = CONTACT_STATE[b[3]];
  if (stateName !== undefined) {
    // Normalize to the vocabulary's lowercase open/closed enum.
    data.action = { contactState: stateName.toLowerCase() };
    data.state = stateName;
  }
  return { data: data };
}

function decodeBatteryVoltage(b) {
  if (b.length !== 4) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    msgType: 'Laird_Battery_Voltage',
    options: decodeBitfield(UPLINK_OPTIONS, b[1]),
    battery: pairToFloat(b[2], b[3])
  };
  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['Invalid message type used!'] };
  }
  switch (bytes[0]) {
    case 0x01:
      return decodeInternalTH(bytes);
    case 0x02:
      return decodeAggTH(bytes);
    case 0x03:
      return decodeBacklogMessage(bytes);
    case 0x04:
      return decodeBacklogMessages(bytes);
    case 0x05:
      return decodeSimpleConfig(bytes);
    case 0x06:
      return decodeAdvancedConfig(bytes);
    case 0x07:
      return decodeFirmwareVersion(bytes);
    case 0x08:
      return decodeContactSensorConfig(bytes);
    case 0x09:
      return decodeContactSensorState(bytes);
    case 0x0a:
      return decodeBatteryVoltage(bytes);
    default:
      return { errors: ['Invalid message type used!'] };
  }
}
