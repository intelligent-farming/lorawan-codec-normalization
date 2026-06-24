// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Arwin Technology LRS10701 (SENSO8 Indoor Air
// Quality / IAQ Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Arwin event/sensor framing per LoRaWAN fPort) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/arwin-technology/lrs10701.js,
// attributed in NOTICE). Ported from the upstream decodeUplink; do NOT copy
// upstream normalizeUplink.
//
// Vocabulary mapping (fPort 10 sensor data): temperature -> air.temperature;
// humidity -> air.relativeHumidity; co2 -> air.co2. The device reports battery
// as a PERCENTAGE, so it is emitted as the camelCase extra `batteryPercent`
// rather than being forced into the vocabulary's volts-based `battery`. The
// device's AQI, event flags, and the two configurable gas-sensor channels have
// no vocabulary equivalent and are emitted as camelCase extras (`aqi`, `event`,
// `gas1`, `gas2`). TVOC and particulate matter (fPort 11) are likewise extras
// (`tvoc`, `pm1_0`, `pm2_5`, `pm10`) — the vocabulary only models air.co2.

var LRS10701_EVENTS = [
  'heartbeat/button',
  'rsvd',
  'T/H',
  'CO2',
  'EC1',
  'EC2',
  'TVOC',
  'PMx'
];
var SENSOR_LIST = ['T/H', 'TVOC', 'CO2', 'PMx', 'Gas1', 'Gas2'];
var GAS_SENSOR_TYPE = ['None', 'NH3', 'H2S', 'NO2', 'CO', 'HCHO', 'Custom'];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Two's-complement of a 16-bit value (ported from upstream hex2dec).
function hex2dec(hex) {
  var dec = hex & 0xffff;
  if (dec & 0x8000) {
    dec = -(0x10000 - dec);
  }
  return dec;
}

function flagList(mask, names) {
  var out = '';
  var i;
  for (i = 0; i < 8; i++) {
    if ((0x01 << i) & mask) {
      out = out === '' ? names[i] : out + ',' + names[i];
    }
  }
  return out;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var data = {};
  var air = {};

  switch (input.fPort) {
    case 10: // sensor data
      var aqiCo2T =
        ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]);
      air.temperature = round((hex2dec(aqiCo2T & 0x3ff) - 300) / 10, 1);
      air.relativeHumidity = round(bytes[5] * 0.5, 1);
      air.co2 = (aqiCo2T >> 10) & 0x1fff;
      data.air = air;
      data.event = flagList(bytes[0], LRS10701_EVENTS);
      data.aqi = (aqiCo2T >> 23) & 0x1ff;
      data.gas1 = round(((bytes[6] << 8) | bytes[7]) / 1000, 3);
      data.gas2 = round(((bytes[8] << 8) | bytes[9]) / 1000, 3);
      data.batteryPercent = bytes[10];
      return { data: data };
    case 11: // TVOC / particulate matter
      data.tvoc = (bytes[0] << 8) | bytes[1];
      data.pm1_0 = round(((bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) / 1000, 3);
      data.pm2_5 = round(((bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) / 1000, 3);
      data.pm10 = round(((bytes[8] << 16) | (bytes[9] << 8) | bytes[10]) / 1000, 3);
      return { data: data };
    case 8: // firmware version
      data.firmwareVersion =
        bytes[0] +
        '.' +
        ('00' + bytes[1]).slice(-2) +
        '.' +
        ('000' + ((bytes[2] << 8) | bytes[3])).slice(-3);
      return { data: data };
    case 12: // device settings
      var sensorType = '';
      var sensorOk = '';
      var i;
      for (i = 0; i < 8; i++) {
        if ((0x01 << i) & bytes[3]) {
          sensorType = sensorType === '' ? SENSOR_LIST[i] : sensorType + ',' + SENSOR_LIST[i];
        }
        if ((0x01 << i) & bytes[4]) {
          sensorOk = sensorOk === '' ? SENSOR_LIST[i] : sensorOk + ',' + SENSOR_LIST[i];
        }
      }
      data.dataUploadInterval = hex2dec((bytes[0] << 8) | bytes[1]);
      data.statusLED = bytes[2] === 1 ? 'on' : 'off';
      data.sensorType = sensorType;
      data.sensorStatus = sensorOk;
      data.gas1Type = GAS_SENSOR_TYPE[bytes[5]];
      data.gas2Type = GAS_SENSOR_TYPE[bytes[6]];
      return { data: data };
    case 13: // threshold settings
      switch (bytes[0]) {
        case 0:
          data.highTemperatureThreshold = hex2dec((bytes[1] << 8) | bytes[2]);
          data.lowTemperatureThreshold = hex2dec((bytes[3] << 8) | bytes[4]);
          data.highHumidityThreshold = bytes[5];
          data.lowHumidityThreshold = bytes[6];
          return { data: data };
        case 1:
          data.co2Threshold = (bytes[1] << 8) | bytes[2];
          data.tvocThreshold = (bytes[3] << 8) | bytes[4];
          data.gas1Threshold = round(((bytes[5] << 8) | bytes[6]) / 1000, 3);
          data.gas2Threshold = round(((bytes[7] << 8) | bytes[8]) / 1000, 3);
          return { data: data };
        case 2:
          data.pm1_0Threshold = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
          data.pm2_5Threshold = (bytes[4] << 16) | (bytes[5] << 8) | bytes[6];
          data.pm10Threshold = (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];
          return { data: data };
        default:
          return { errors: ['unknown packet type'] };
      }
    default:
      return { errors: ['unknown FPort'] };
  }
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "arwin-technology";
    result.data.model = "lrs10701";
  }
  return result;
}
