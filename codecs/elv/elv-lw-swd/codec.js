// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ELV LW-SWD (LoRaWAN Soil/Water moisture
// detector). Despite the "soil" in the product name this is NOT an in-ground
// VWC probe: it reports no soil moisture percentage and no soil temperature.
// It is a state detector that reports boolean dryness / moisture / water
// (wet) flags plus a tilt angle, so it normalizes to the water-leak
// category: the genuine "water present / wet" boolean maps to water.leak.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-swd.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// Wire layout (fPort 10), ported faithfully from the upstream decoder:
//   bytes[0]   supply voltage: 1 + (b>>6) + (b & 0x3F)*0.02  -> battery (V)
//   bytes[1]   frame type index (0..3): Device_Info, Device_State,
//              Sensor_Data, Config_Data
//   bytes[2]   TX reason index
//   bytes[3..] frame-type-specific payload (see switch below)
//
// The Water (wet) boolean lives in bit 2 of bytes[4] on the Device_State and
// Sensor_Data frames; that is the leak/wet boolean -> water.leak. Dryness,
// moisture, tilt, error, activation count, frame type and TX reason have no
// vocabulary key and are emitted as camelCase extras.

var TX_REASON = [
  'Reserved',
  'Join Button Pressed',
  'Cyclic Timer',
  'Settings',
  'Joined',
  'Tilt',
  'Dryness',
  'Moisture',
  'Water'
];
var FRAME_TYPE = ['Device_Info', 'Device_State', 'Sensor_Data', 'Config_Data'];
var DEVICE_MODES = ['Dryness', 'Moisture', 'Water', 'Tilt'];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 10)'] };
  }
  if (!bytes || bytes.length < 5) {
    return { errors: ['expected at least 5 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var frameType = FRAME_TYPE[bytes[1]];
  if (frameType === undefined) {
    return { errors: ['unknown frame type ' + bytes[1]] };
  }

  var data = {};

  // bytes[0]: supply voltage, 0.02 V resolution -> battery (V).
  data.battery = round(1 + (bytes[0] >> 6) + (bytes[0] & 0x3f) * 0.02, 2);

  // Frame type and TX reason are device diagnostics; camelCase extras.
  data.frameType = frameType;
  data.txReason = TX_REASON[bytes[2]];

  if (frameType === 'Device_Info') {
    if (bytes.length < 11) {
      return { errors: ['Device_Info frame: expected at least 11 bytes, got ' + bytes.length] };
    }
    data.bootloaderVersion = bytes[3] + '.' + bytes[4] + '.' + bytes[5];
    data.firmwareVersion = bytes[6] + '.' + bytes[7] + '.' + bytes[8];
    data.hwRevision = (bytes[9] << 8) | bytes[10];
    return { data: data };
  }

  if (frameType === 'Device_State') {
    if (bytes.length < 8) {
      return { errors: ['Device_State frame: expected at least 8 bytes, got ' + bytes.length] };
    }
    data.errorMsg = bytes[3];
    data.dryness = (bytes[4] & 0x1) !== 0;
    data.moisture = (bytes[4] & 0x2) !== 0;
    // Water (wet) boolean -> vocabulary water.leak.
    data.water = { leak: (bytes[4] & 0x4) !== 0 };
    data.tiltAngle = bytes[5];
    data.activationCount = (bytes[6] << 8) | bytes[7];
    return { data: data };
  }

  if (frameType === 'Sensor_Data') {
    if (bytes.length < 6) {
      return { errors: ['Sensor_Data frame: expected at least 6 bytes, got ' + bytes.length] };
    }
    data.errorMsg = bytes[3];
    data.dry = (bytes[4] & 0x1) !== 0;
    data.moisture = (bytes[4] & 0x2) !== 0;
    // Water (wet) boolean -> vocabulary water.leak.
    data.water = { leak: (bytes[4] & 0x4) !== 0 };
    data.tiltAngle = bytes[5];
    return { data: data };
  }

  // Config_Data
  if (bytes.length < 18) {
    return { errors: ['Config_Data frame: expected at least 18 bytes, got ' + bytes.length] };
  }
  data.datarate = 'DR' + (bytes[3] + 1);
  data.sendCycle = bytes[4];
  var mode = '';
  for (var i = 0; i < 8; i++) {
    if ((bytes[5] >> i) & 1) {
      mode += DEVICE_MODES[i] || '';
    }
  }
  data.deviceMode = mode;
  data.triggerAngle = bytes[6];
  data.acousticAlarmTriggerSource = bytes[7];
  data.acousticAlarmSignalDryness = bytes[8];
  data.acousticAlarmDurationDryness = bytes[9];
  data.acousticAlarmSignalMoisture = bytes[10];
  data.acousticAlarmDurationMoisture = bytes[11];
  data.acousticAlarmSignalWater = bytes[12];
  data.acousticAlarmDurationWater = bytes[13];
  data.acousticAlarmSignalFlat = bytes[14];
  data.acousticAlarmDurationFlat = bytes[15];
  data.acousticAlarmSignalTilt = bytes[16];
  data.acousticAlarmDurationTilt = bytes[17];
  return { data: data };
}
