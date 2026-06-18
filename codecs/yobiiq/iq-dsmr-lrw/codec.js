// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for YOBIIQ iQ-DSMR-LRW (Dutch Smart Meter
// Requirements P1 reader). The device reports electricity (and, via its P1
// slave channels, gas/water/heat) metering, plus an onboard ambient
// temperature/humidity sensor and enclosure diagnostics.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (YOBIIQ channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/yobiiq/iq-dsmr-lrw.js, attributed in NOTICE). Ported from the upstream
// Decode/decodeUplink faithfully; the only normalization changes are mapping
// the ambient sensor to the shared vocabulary (air.temperature,
// air.relativeHumidity), routing battery voltage to `battery` (V) and battery
// percentage to the `batteryPercent` extra, and returning {errors} instead of
// upstream's {data:{error}} envelope on a bad fPort. All metering / electrical
// / diagnostic fields are preserved verbatim as camelCase extras: the
// vocabulary has NO electricity- or gas-metering key, and metering.water.total
// is WATER volume only, so meter readings must not be forced into it.

// --- Basic-information (fPort 50) field table ---
var INFO_CHANNEL = 0xff;
var INFO_TYPES = {
  '0x05': { size: 2, name: 'hardwareVersion', digit: false },
  '0x04': { size: 2, name: 'firmwareVersion', digit: false },
  '0x03': { size: 4, name: 'deviceSerialNumber' },
  '0x01': { size: 0, name: 'manufacturer' },
  '0x02': { size: 0, name: 'deviceModel' },
  '0x07': { size: 1, name: 'batteryPercentage' },
  '0x08': { size: 1, name: 'batteryVoltage', resolution: 0.1 },
  '0x11': {
    size: 1,
    name: 'deviceClass',
    values: { '0x00': 'Class A', '0x01': 'Class B', '0x02': 'Class C' }
  },
  '0x06': {
    size: 1,
    name: 'powerEvent',
    values: { '0x00': 'AC Power Off', '0x01': 'AC Power On' }
  }
};

// --- Measurement (fPort 1-10) field table ---
var MEAS_FPORT_MIN = 1;
var MEAS_FPORT_MAX = 10;
var MEAS = {
  '0xFE': { size: 4, name: 'deviceTimestamp' },
  '0x00': { size: 2, name: 'p1Version', resolution: 0.1 },
  '0x02': { size: 4, name: 'telegramTimestamp' },
  '0x06': { size: 4, name: 'electricityDeliveredToClientT1', unit: 'Wh' },
  '0x08': { size: 4, name: 'electricityDeliveredToClientT2', unit: 'Wh' },
  '0x0A': { size: 4, name: 'electricityDeliveredByClientT1', unit: 'Wh' },
  '0x0C': { size: 4, name: 'electricityDeliveredByClientT2', unit: 'Wh' },
  '0x0E': { size: 2, name: 'tariffIndicator' },
  '0x10': { size: 4, name: 'electricityPowerDelivered', unit: 'W', signed: true },
  '0x12': { size: 4, name: 'electricityPowerReceived', unit: 'W', signed: true },
  '0x14': { size: 4, name: 'numberOfPowerFailuresInAnyPhase' },
  '0x18': { size: 0, name: 'powerFailureEventLog', singleEventSize: 8 },
  '0x1A': { size: 4, name: 'numberOfVoltageSagsL1' },
  '0x1C': { size: 4, name: 'numberOfVoltageSagsL2' },
  '0x1E': { size: 4, name: 'numberOfVoltageSagsL3' },
  '0x1F': { size: 4, name: 'numberOfVoltageSwellsL1' },
  '0x20': { size: 4, name: 'numberOfVoltageSwellsL2' },
  '0x21': { size: 4, name: 'numberOfVoltageSwellsL3' },
  '0x22': { size: 4, name: 'voltageL1', unit: 'V', resolution: 0.1, signed: true },
  '0x23': { size: 4, name: 'voltageL2', unit: 'V', resolution: 0.1, signed: true },
  '0x24': { size: 4, name: 'voltageL3', unit: 'V', resolution: 0.1, signed: true },
  '0x26': { size: 4, name: 'currentL1', unit: 'A', signed: true },
  '0x28': { size: 4, name: 'currentL2', unit: 'A', signed: true },
  '0x2A': { size: 4, name: 'currentL3', unit: 'A', signed: true },
  '0x2C': { size: 4, name: 'activePowerDeliveredL1', unit: 'W', signed: true },
  '0x2E': { size: 4, name: 'activePowerDeliveredL2', unit: 'W', signed: true },
  '0x30': { size: 4, name: 'activePowerDeliveredL3', unit: 'W', signed: true },
  '0x32': { size: 4, name: 'activePowerReceivedL1', unit: 'W', signed: true },
  '0x33': { size: 4, name: 'activePowerReceivedL2', unit: 'W', signed: true },
  '0x34': { size: 4, name: 'activePowerReceivedL3', unit: 'W', signed: true },
  '0x46': { size: 2, name: 'deviceTypeOnChannel1' },
  '0x50': { size: 8, name: 'lastReadingOnChannel1' },
  '0x56': { size: 2, name: 'deviceTypeOnChannel2' },
  '0x60': { size: 8, name: 'lastReadingOnChannel2' },
  '0x66': { size: 2, name: 'deviceTypeOnChannel3' },
  '0x70': { size: 8, name: 'lastReadingOnChannel3' },
  '0x76': { size: 2, name: 'deviceTypeOnChannel4' },
  '0x80': { size: 8, name: 'lastReadingOnChannel4' },
  '0x71': { size: 2, name: 'internalCircuitTemperature', resolution: 0.01 },
  '0x72': { size: 1, name: 'internalCircuitHumidity' },
  '0x81': { size: 2, name: 'ambientTemperature', resolution: 0.01 },
  '0x82': { size: 1, name: 'ambientHumidity' },
  '0xD1': { size: 4, name: 'pulseCounterDryInput1' },
  '0xD2': { size: 4, name: 'pulseCounterDryInput2' }
};

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function toEvenHex(hex) {
  return hex.length === 1 ? '0' + hex : hex;
}

function typeKey(b) {
  return '0x' + toEvenHex(b.toString(16).toUpperCase());
}

// Big-endian unsigned integer over `size` bytes.
function readUintBE(bytes, index, size) {
  var value = 0;
  for (var i = 0; i < size - 1; i = i + 1) {
    value = (value | bytes[index + i]) << 8;
  }
  value = value | bytes[index + size - 1];
  return value >>> 0;
}

function toSigned(integer, size) {
  var signMask = 1 << (size * 8 - 1);
  var dataMask = (1 << (size * 8 - 1)) - 1;
  if (integer & signMask) {
    return -(~integer & dataMask) - 1;
  }
  return integer & dataMask;
}

// Big-endian ASCII string over `size` bytes.
function readStringBE(bytes, index, size) {
  var value = '';
  for (var i = 0; i < size; i = i + 1) {
    value = value + String.fromCharCode(bytes[index + i]);
  }
  return value;
}

// "V<major>.<minor>" version string from a 2-byte field.
function readVersion(bytes, index, size) {
  var parts = [];
  for (var i = 0; i < size; i = i + 1) {
    parts.push(bytes[index + i].toString(16));
  }
  return 'V' + parts[0] + '.' + parts[1];
}

// Manufacturer / device-model strings have no length byte; they run until the
// next channel marker (0xFF) or the end of the buffer.
function variableStringSize(bytes, index) {
  var size = 0;
  while (index + size < bytes.length && bytes[index + size] !== INFO_CHANNEL) {
    size = size + 1;
  }
  return size;
}

function readPowerFailureEventLog(bytes, index, size) {
  var log = [];
  for (var i = index; i < index + size; i = i + 8) {
    log.push({
      timestamp: readUintBE(bytes, i, 4),
      duration: readUintBE(bytes, i + 4, 4)
    });
  }
  return log;
}

function decodeBasicInformation(bytes, extras) {
  var index = 0;
  while (index + 1 < bytes.length) {
    var channel = bytes[index];
    index = index + 1;
    if (channel !== INFO_CHANNEL) {
      continue;
    }
    var type = typeKey(bytes[index]);
    index = index + 1;
    var info = INFO_TYPES[type];
    if (!info) {
      return 'unknown basic-information type ' + type;
    }
    var size = info.size;
    var value;
    if (info.digit === false) {
      value = readVersion(bytes, index, size);
    } else if (info.values) {
      value = info.values[typeKey(bytes[index])];
    } else if (size === 0) {
      size = variableStringSize(bytes, index);
      value = readStringBE(bytes, index, size);
    } else {
      value = readUintBE(bytes, index, size);
      if (info.resolution) {
        value = round(value * info.resolution, 2);
      }
    }
    extras[info.name] = value;
    index = index + size;
  }
  return null;
}

function decodeMeasurement(bytes, extras, ambient) {
  var index = 0;
  while (index + 1 < bytes.length) {
    // The channel byte is not validated upstream; it is consumed and ignored.
    index = index + 1;
    var type = typeKey(bytes[index]);
    index = index + 1;
    var field = MEAS[type];
    if (!field) {
      return 'unknown measurement type ' + type;
    }
    var size = field.size;

    if (size === 0) {
      // Power-failure event log: a 4-byte count precedes the event entries.
      var count = readUintBE(bytes, index, 4);
      index = index + 4;
      size = field.singleEventSize * count;
      extras[field.name] = readPowerFailureEventLog(bytes, index, size);
      index = index + size;
      continue;
    }
    if (size === 8) {
      // P1 slave-channel last reading {timestamp, value}: carries gas / water /
      // heat meters wired to the P1 port. The vocabulary has no key for them
      // (metering.water.total is WATER volume only), so keep as an extra.
      var ts = readUintBE(bytes, index, 4);
      index = index + 4;
      var reading = readUintBE(bytes, index, 4);
      index = index + 4;
      extras[field.name] = { timestamp: ts, value: reading };
      continue;
    }

    var raw = readUintBE(bytes, index, size);
    var out = field.signed ? toSigned(raw, size) : raw;
    if (field.resolution) {
      out = round(out * field.resolution, 2);
    }
    index = index + size;

    if (field.name === 'ambientTemperature') {
      ambient.temperature = out;
    } else if (field.name === 'ambientHumidity') {
      ambient.relativeHumidity = out;
    } else if (field.unit) {
      extras[field.name] = { data: out, unit: field.unit };
    } else {
      extras[field.name] = out;
    }
  }
  return null;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  // Single-byte payloads on the info / metering ports are downlink ACKs.
  var isInfoOrMeas =
    fPort === 50 || (fPort >= MEAS_FPORT_MIN && fPort <= MEAS_FPORT_MAX);
  if (bytes.length === 1 && isInfoOrMeas) {
    if (bytes[0] === 0) {
      return { data: { downlinkAck: 'Downlink command succeeded' } };
    }
    if (bytes[0] === 1) {
      return {
        data: { downlinkAck: 'Downlink command failed' },
        warnings: ['device reported downlink command failed']
      };
    }
  }

  var data = {};
  var extras = {};
  var ambient = {};
  var err = null;

  if (fPort === 0) {
    return { data: { mac: 'MAC command received', fPort: fPort } };
  } else if (fPort === 50) {
    err = decodeBasicInformation(bytes, extras);
  } else if (fPort >= MEAS_FPORT_MIN && fPort <= MEAS_FPORT_MAX) {
    err = decodeMeasurement(bytes, extras, ambient);
  } else if (fPort === 11) {
    return { data: { status: 'status packet' } };
  } else {
    return { errors: ['incorrect fPort ' + fPort] };
  }

  if (err) {
    return { errors: [err] };
  }

  // Battery voltage (V) maps to the vocabulary `battery`; the percentage is the
  // `batteryPercent` extra (vocabulary `battery` is volts, not percent).
  if (extras.batteryVoltage !== undefined) {
    data.battery = extras.batteryVoltage;
    delete extras.batteryVoltage;
  }
  if (extras.batteryPercentage !== undefined) {
    data.batteryPercent = extras.batteryPercentage;
    delete extras.batteryPercentage;
  }

  if (ambient.temperature !== undefined || ambient.relativeHumidity !== undefined) {
    data.air = ambient;
  }

  // Fold the remaining decoded fields in as camelCase extras.
  var key;
  for (key in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, key)) {
      data[key] = extras[key];
    }
  }

  return { data: data };
}
