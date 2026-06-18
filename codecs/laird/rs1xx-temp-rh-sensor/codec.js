// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Laird Sentrius RS1xx Temperature + Humidity
// sensor (Laird is Ezurio's former brand; same wire format as
// ezurio/rs1xx-temp-rh-sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/laird/rs1xx-temp-rh-sensor.js,
// attributed in NOTICE). The upstream `decodeUplink` dispatch + per-message
// field layout is reproduced faithfully; the upstream `normalizeUplink` is NOT
// copied — we author normalization to the shared vocabulary ourselves.
//
// Notes on this device's wire format:
//   * Temperature is reported in degrees FAHRENHEIT and converted to °C with
//     (°F - 32) * 5/9 for `air.temperature`.
//   * Each temperature/humidity value is two bytes: byte[0] is a signed int8
//     hundredths (fractional) part, byte[1] is a signed int8 integer part;
//     value = integer + fractional / 100.
//   * Multi-byte integer fields (counts, voltage, part number, RTC seconds) are
//     BIG-ENDIAN.
//   * Battery is reported two ways: TH/aggregate messages carry a coarse
//     capacity BUCKET (e.g. "80-100%"), emitted as the string extra
//     `batteryCapacity`; the dedicated battery-voltage message carries a real
//     voltage, emitted as the vocabulary key `battery` (volts).
//   * Aggregated / backlog uplinks are datalog: the most recent reading is at
//     the top level and earlier readings go in `history`, each with an RFC3339
//     `time`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function byteToInt8(b) {
  return b > 0x7f ? b - 0x100 : b;
}

// Two bytes -> signed fixed-point float. byte[0] = signed hundredths,
// byte[1] = signed integer part. value = integer + fractional / 100.
function twoBytesToFloat(b0, b1) {
  var fractional = byteToInt8(b0);
  var integer = byteToInt8(b1);
  return integer + fractional / 100.0;
}

// Big-endian unsigned 16-bit.
function twoBytesToUInt16(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// Big-endian unsigned 32-bit.
function fourBytesToUInt32(b0, b1, b2, b3) {
  return ((b0 * 0x1000000) + (b1 << 16) + (b2 << 8) + b3) >>> 0;
}

var BATTERY_CAPACITY = ['0-5%', '5-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
var BATTERY_TYPE = { 1: 'Alkaline', 2: 'Lithium' };
var UPLINK_OPTION_BITS = [
  { bit: 0x01, label: 'Sensor request for server time' },
  { bit: 0x02, label: 'Sensor configuration error' },
  { bit: 0x04, label: 'Sensor alarm flag' },
  { bit: 0x08, label: 'Sensor reset flag' },
  { bit: 0x10, label: 'Sensor fault flag' }
];

// Decode the uplink options bitfield into an array of labels (matching upstream:
// 0 -> ["None"]; recognized bits expanded in order).
function decodeOptions(value) {
  if (value === 0) {
    return ['None'];
  }
  var labels = [];
  var remaining = value;
  for (var i = 0; i < UPLINK_OPTION_BITS.length && remaining > 0; i++) {
    var b = UPLINK_OPTION_BITS[i].bit;
    if ((remaining & b) === b) {
      labels.push(UPLINK_OPTION_BITS[i].label);
      remaining -= b;
    }
  }
  return labels;
}

// 4 bytes (big-endian seconds since 2015-01-01T00:00:00Z) -> RFC3339 string.
var RS1XX_EPOCH_MS = Date.UTC(2015, 0, 1, 0, 0, 0);
function rtcToIso(b0, b1, b2, b3) {
  var seconds = fourBytesToUInt32(b0, b1, b2, b3);
  return new Date(RS1XX_EPOCH_MS + seconds * 1000).toISOString();
}

// (°F -> °C), rounded to the device's effective resolution.
function fahrenheitToCelsius(f) {
  return round((f - 32) * 5 / 9, 2);
}

function thReading(humidityF0, humidityF1, tempF0, tempF1) {
  return {
    air: {
      temperature: fahrenheitToCelsius(twoBytesToFloat(tempF0, tempF1)),
      relativeHumidity: round(twoBytesToFloat(humidityF0, humidityF1), 2)
    }
  };
}

// ---- Message type 0x01: Laird_Internal_TH -------------------------------
function decodeInternalTH(b) {
  if (b.length !== 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var reading = thReading(b[2], b[3], b[4], b[5]);
  var data = {
    air: reading.air,
    messageType: 'Laird_Internal_TH',
    options: decodeOptions(b[1]),
    batteryCapacity: BATTERY_CAPACITY[b[6]],
    alarmMessageCount: twoBytesToUInt16(b[7], b[8]),
    backlogMessageCount: twoBytesToUInt16(b[9], b[10])
  };
  return { data: data };
}

// ---- Message type 0x02: Laird_Agg_TH ------------------------------------
function decodeAggTH(b) {
  if (b.length <= 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var readingsBytes = b[6] * 4;
  if (b.length !== readingsBytes + 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var options = decodeOptions(b[1]);
  var alarmMessageCount = b[2];
  var backlogMessageCount = twoBytesToUInt16(b[3], b[4]);
  var batteryCapacity = BATTERY_CAPACITY[b[5]];
  var numberOfReadings = b[6];
  var time = rtcToIso(b[7], b[8], b[9], b[10]);

  var readings = [];
  var idx = 11;
  for (var i = 0; i < numberOfReadings; i++) {
    var r = thReading(b[idx], b[idx + 1], b[idx + 2], b[idx + 3]);
    readings.push(r);
    idx += 4;
  }

  // Datalog: most recent reading at top level; earlier readings in history.
  // The aggregate message carries a single timestamp shared by all readings.
  var latest = readings[readings.length - 1];
  var data = {
    time: time,
    air: latest.air,
    messageType: 'Laird_Agg_TH',
    options: options,
    batteryCapacity: batteryCapacity,
    alarmMessageCount: alarmMessageCount,
    backlogMessageCount: backlogMessageCount,
    numberOfReadings: numberOfReadings
  };
  if (readings.length > 1) {
    var history = [];
    for (var j = 0; j < readings.length - 1; j++) {
      history.push({ time: time, air: readings[j].air });
    }
    data.history = history;
  }
  return { data: data };
}

// ---- Message type 0x03: SendBackLogMessage ------------------------------
function decodeBacklogMessage(b) {
  if (b.length !== 10) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var reading = thReading(b[6], b[7], b[8], b[9]);
  var data = {
    time: rtcToIso(b[2], b[3], b[4], b[5]),
    air: reading.air,
    messageType: 'SendBackLogMessage',
    options: decodeOptions(b[1])
  };
  return { data: data };
}

// ---- Message type 0x04: SendBackLogMessages -----------------------------
function decodeBacklogMessages(b) {
  if (b.length < 11 || (b.length - 3) % 8 !== 0) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var options = decodeOptions(b[1]);
  var numberOfReadings = b[2];

  var readings = [];
  var idx = 3;
  while (idx < b.length) {
    var time = rtcToIso(b[idx], b[idx + 1], b[idx + 2], b[idx + 3]);
    idx += 4;
    var r = thReading(b[idx], b[idx + 1], b[idx + 2], b[idx + 3]);
    idx += 4;
    readings.push({ time: time, air: r.air });
  }

  // Datalog: most recent reading at top level; earlier readings in history.
  var latest = readings[readings.length - 1];
  var data = {
    time: latest.time,
    air: latest.air,
    messageType: 'SendBackLogMessages',
    options: options,
    numberOfReadings: numberOfReadings
  };
  if (readings.length > 1) {
    var history = [];
    for (var j = 0; j < readings.length - 1; j++) {
      history.push({ time: readings[j].time, air: readings[j].air });
    }
    data.history = history;
  }
  return { data: data };
}

// ---- Message type 0x05: Laird_Simple_Config -----------------------------
function decodeSimpleConfig(b) {
  if (b.length !== 8) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    messageType: 'Laird_Simple_Config',
    options: decodeOptions(b[1]),
    batteryType: BATTERY_TYPE[b[2]],
    sensorReadPeriod: twoBytesToUInt16(b[3], b[4]),
    sensorAggregate: b[5],
    tempAlarmsEnabled: b[6] === 1,
    humidityAlarmsEnabled: b[7] === 1
  };
  return { data: data };
}

// ---- Message type 0x06: Laird_Advanced_Config ---------------------------
function decodeAdvancedConfig(b) {
  if (b.length !== 16) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    messageType: 'Laird_Advanced_Config',
    options: decodeOptions(b[1]),
    batteryType: BATTERY_TYPE[b[2]],
    sensorReadPeriod: twoBytesToUInt16(b[3], b[4]),
    sensorAggregate: b[5],
    tempAlarmsEnabled: b[6] === 1,
    humidityAlarmsEnabled: b[7] === 1,
    tempAlarmLimitLow: byteToInt8(b[8]),
    tempAlarmLimitHigh: byteToInt8(b[9]),
    humidityAlarmLimitLow: b[10],
    humidityAlarmLimitHigh: b[11],
    ledBle: twoBytesToUInt16(b[12], b[13]),
    ledLora: twoBytesToUInt16(b[14], b[15])
  };
  return { data: data };
}

// ---- Message type 0x07: Laird_FW_Version --------------------------------
function decodeFirmwareVersion(b) {
  if (b.length !== 11) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    messageType: 'Laird_FW_Version',
    options: decodeOptions(b[1]),
    releaseDate: String(b[2]) + '/' + String(b[3]) + '/' + String(b[4]),
    releaseNumber: String(b[5]) + '.' + String(b[6]),
    partNumber: fourBytesToUInt32(b[7], b[8], b[9], b[10])
  };
  return { data: data };
}

// ---- Message type 0x0A: Laird_Battery_Voltage ---------------------------
function decodeBatteryVoltage(b) {
  if (b.length !== 4) {
    return { errors: ['Invalid uplink message length!'] };
  }
  var data = {
    battery: round(twoBytesToFloat(b[2], b[3]), 2),
    messageType: 'Laird_Battery_Voltage',
    options: decodeOptions(b[1])
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
    case 0x0a:
      return decodeBatteryVoltage(bytes);
    default:
      return { errors: ['Invalid message type used!'] };
  }
}
