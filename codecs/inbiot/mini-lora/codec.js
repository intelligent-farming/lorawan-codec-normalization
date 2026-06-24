// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for inBiot MICA MINI (LoRaWAN indoor air-quality
// monitor: temperature, humidity, CO2, plus inBiot comfort/air indices).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (inBiot message-type byte at bytes[0]: 0 = configuration, 1 = sensor
// reading, 2 = device information) was ported/normalized from the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices vendor/inbiot/decoder.js,
// attributed in NOTICE). The byte math below is faithful to that decoder; only
// the output is reshaped to this module's vocabulary.
//
// Mapping: temperature -> air.temperature (raw uint16 / 10, degrees C);
// humidity -> air.relativeHumidity (raw uint16 / 10, percent); CO2 ->
// air.co2 (ppm). The device's own MICA `type`, particulate/gas readings
// (tvoc, pm2_5, pm10, ch2o, pm1_0, pm4, o3, no2, co) and comfort indices
// (vIndex, tIndex, virusIndex, iaqIndex, moldIndex, dB, counter) have no
// vocabulary key, so they are emitted as camelCase extras. The MINI variant
// reports only temperature/humidity/CO2 of these; the larger MICA/PLUS/WELL
// fields are decoded for the other variants this firmware family shares.
//
// Only the sensor reading (bytes[0] === 1) carries normalized measurements.
// Configuration (0) and device-information (2) frames are device-management
// messages with no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function getUint16(bytes, first, second) {
  return ((bytes[first] << 8) | bytes[second]) & 0xffff;
}

function customTextDecoder(bytes, start, end) {
  var result = '';
  for (var i = start; i < end; i++) {
    if (bytes[i] === undefined || bytes[i] === 0x00) {
      break;
    }
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function decodeSensor(bytes) {
  var data = {};
  var air = {};

  // MICA TYPE: ASCII at bytes[27..30].
  var type = customTextDecoder(bytes, 27, 31);
  if (type === '') {
    type = 'NULL';
  }
  var known = { MINI: true, MICA: true, PLUS: true, WELL: true, NULL: true };
  if (!known[type]) {
    return { errors: ['unrecognized inBiot device type "' + type + '"'] };
  }
  data.type = type;

  // TEMPERATURE / HUMIDITY are raw uint16 / 10; CO2 is raw uint16 ppm.
  air.temperature = round(getUint16(bytes, 1, 2) / 10.0, 1);
  air.relativeHumidity = round(getUint16(bytes, 3, 4) / 10.0, 1);
  air.co2 = getUint16(bytes, 5, 6);

  if (type !== 'MINI') {
    data.tvoc = getUint16(bytes, 9, 10);
    data.pm2_5 = getUint16(bytes, 13, 14);
    data.pm10 = getUint16(bytes, 17, 18);
  }
  if (type === 'PLUS' || type === 'WELL' || type === 'NULL') {
    data.ch2o = getUint16(bytes, 7, 8);
    data.pm1_0 = getUint16(bytes, 11, 12);
    data.pm4 = getUint16(bytes, 15, 16);
  }
  if (type === 'WELL' || type === 'NULL') {
    var o3 = getUint16(bytes, 19, 20);
    data.o3 = o3 === 0xffff ? 'Preheating' : o3;
    var no2 = getUint16(bytes, 21, 22);
    data.no2 = no2 === 0xffff ? 'Preheating' : no2;
    var co = getUint16(bytes, 23, 24);
    data.co = co === 0xffff ? 'Preheating' : round(co / 10.0, 1);
  }

  // Comfort / air indices.
  data.vIndex = bytes[32];
  data.tIndex = bytes[33];
  data.virusIndex = bytes[34];
  data.iaqIndex = bytes[35];
  data.moldIndex = bytes[36] === 0xff ? 'Calculating' : bytes[36];
  if (bytes[37]) {
    data.dB = bytes[37] === 0xff ? 'Preheating' : bytes[37];
  }
  data.counter = getUint16(bytes, 25, 26);

  data.air = air;
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  if (bytes[0] === 1) {
    if (bytes.length < 38) {
      return { errors: ['sensor reading too short: expected at least 38 bytes'] };
    }
    return decodeSensor(bytes);
  }

  if (bytes[0] === 0) {
    return { errors: ['configuration frame carries no measurement'] };
  }
  if (bytes[0] === 2) {
    return { errors: ['device-information frame carries no measurement'] };
  }

  return { errors: ['unsupported inBiot message type: ' + bytes[0]] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "inbiot";
    result.data.model = "mini-lora";
  }
  return result;
}
