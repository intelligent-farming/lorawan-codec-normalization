// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the ELV LW-MOB (LoRaWAN motion / movement
// sensor: a 3-axis accelerometer with tilt-area detection plus an application
// button). The node frames an acceleration / tilt state, a button counter, and
// device-info / config frames, all prefixed by a supply-voltage byte and a
// transmit-reason byte.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-mob.js, attributed in
// NOTICE). The upstream field extraction (header byte + frame-type byte +
// per-frame layout) is reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream decoded output).
//
// All application data arrives on fPort 10:
//   bytes[0]   supply voltage:  (1 + (bytes[0] >> 6)) + (bytes[0] & 0x3F)*0.02
//              volts -> battery (V)
//   bytes[1]   frame type (index into FRAME_TYPE)
//   bytes[2]   transmit reason (index into TX_REASON) -> txReason (extra)
//   bytes[3..] frame-type-specific payload:
//     Device_State (1):    bit-flags (Accelerated/Tilt0..2), Angle, 16-bit
//                          activation count. Accelerated -> action.motion.detected;
//                          activation count -> action.motion.count.
//     Acceleration_Data(2):bit-flags + Angle. Accelerated -> action.motion.detected.
//     Button_Pressed (3):  8-bit button counter -> buttonCount (extra) and
//                          buttonPressed (extra, count > 0).
//     Device_Info (0):     bootloader / firmware version + hardware revision.
//     Config_Data (4):     device mode list, datarate, sensor range/threshold,
//                          filter alpha/beta, hysteresis, send cycle.
//
// Tilt areas, angle and all non-motion frame fields are carried as camelCase
// extras; movement is the only vocabulary signal this device produces.

var FRAME_TYPE = [
  'Device_Info',
  'Device_State',
  'Acceleration_Data',
  'Button_Pressed',
  'Config_Data'
];

var TX_REASON = [
  'Undefined',
  'Join Button Pressed',
  'Cyclic Timer',
  'Settings',
  'Joined',
  'Acceleration',
  'Tilt',
  'Ongoing Acceleration',
  'Inactivity',
  'Short App Button Pressed',
  'Long App Button Pressed'
];

var DEVICE_MODES = ['Button', 'Acceleration', 'Tilt'];
var SENSOR_RANGES = ['2 g', '4 g', '8 g', '16 g'];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }
  if (port !== 10) {
    return { errors: ['unsupported FPort (expected 10)'] };
  }
  if (bytes.length < 3) {
    return { errors: ['header requires at least 3 bytes'] };
  }

  var data = {};

  // Supply voltage byte -> battery (V).
  data.battery = round((1 + (bytes[0] >> 6)) + (bytes[0] & 0x3f) * 0.02, 2);

  var frameType = FRAME_TYPE[bytes[1]];
  if (frameType === undefined) {
    return { errors: ['unknown frame type ' + bytes[1]] };
  }
  data.frameType = frameType;
  data.txReason = TX_REASON[bytes[2]] !== undefined ? TX_REASON[bytes[2]] : 'Undefined';

  if (frameType === 'Device_Info') {
    if (bytes.length < 11) {
      return { errors: ['truncated Device_Info frame'] };
    }
    data.bootloaderVersion = bytes[3] + '.' + bytes[4] + '.' + bytes[5];
    data.firmwareVersion = bytes[6] + '.' + bytes[7] + '.' + bytes[8];
    data.hwRevision = (bytes[9] << 8) | bytes[10];
    return { data: data };
  }

  if (frameType === 'Device_State') {
    if (bytes.length < 7) {
      return { errors: ['truncated Device_State frame'] };
    }
    var stateAccelerated = !!(bytes[3] & 0x1);
    var activationCount = (bytes[5] << 8) | bytes[6];
    data.action = { motion: { detected: stateAccelerated, count: activationCount } };
    data.tiltArea0 = !!(bytes[3] & 0x2);
    data.tiltArea1 = !!(bytes[3] & 0x4);
    data.tiltArea2 = !!(bytes[3] & 0x8);
    data.angle = bytes[4];
    return { data: data };
  }

  if (frameType === 'Acceleration_Data') {
    if (bytes.length < 5) {
      return { errors: ['truncated Acceleration_Data frame'] };
    }
    data.action = { motion: { detected: !!(bytes[3] & 0x1) } };
    data.tiltArea0 = !!(bytes[3] & 0x2);
    data.tiltArea1 = !!(bytes[3] & 0x4);
    data.tiltArea2 = !!(bytes[3] & 0x8);
    data.angle = bytes[4];
    return { data: data };
  }

  if (frameType === 'Button_Pressed') {
    if (bytes.length < 4) {
      return { errors: ['truncated Button_Pressed frame'] };
    }
    data.buttonCount = bytes[3];
    data.buttonPressed = bytes[3] > 0;
    return { data: data };
  }

  if (frameType === 'Config_Data') {
    if (bytes.length < 11) {
      return { errors: ['truncated Config_Data frame'] };
    }
    var mode = '';
    var i;
    for (i = 0; i < DEVICE_MODES.length; i++) {
      if ((bytes[3] >> i) & 1) {
        mode += DEVICE_MODES[i];
      }
    }
    data.deviceMode = mode;
    data.datarate = 'DR' + (bytes[4] + 1);
    data.sensorRange = SENSOR_RANGES[bytes[5]];
    data.sensorThreshold = bytes[6];
    data.alpha = bytes[7];
    data.beta = bytes[8];
    data.hysteresis = bytes[9];
    data.sendCycle = bytes[10];
    return { data: data };
  }

  return { errors: ['unsupported frame type'] };
}
