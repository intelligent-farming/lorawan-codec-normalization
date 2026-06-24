// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the ELV LW-OMO (LoRaWAN open / motion / movement
// sensor: a 3-axis accelerometer with tilt detection plus a user button). The
// device reports acceleration ("movement") events, a cumulative activation
// count, tilt orientation, supply voltage and a transmit-reason byte.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-omo.js, attributed in
// NOTICE). The upstream field extraction (a header plus frame-type-dispatched
// body on fPort 10) is reproduced faithfully; only the JSON shape is re-authored
// to the normalized vocabulary (never the upstream `decoded` object).
//
// All application data arrives on fPort 10. The first three bytes are a header:
//   bytes[0]            supply voltage in units of 10 mV -> battery (V)
//                       (datasheet/upstream: byte * 10 = millivolts)
//   bytes[1]            frame type (index into FRAME_TYPE)
//   bytes[2]            transmit reason (index into TX_REASON) -> txReason (extra)
// The remaining bytes depend on the frame type:
//   Device_Info  (0)  bl x.y.z, fw x.y.z, hw rev (16-bit) -> blVersion / fwVersion / hwRevision
//   Device_State (1)  status bits, angle, 16-bit activation count
//   Accel_Data   (2)  status bits, angle
//   Button       (3)  button press count -> buttonCount (extra)
//   Config_Data  (4)  device mode + thresholds -> config extras
//
// Motion normalization: this is an accelerometer movement sensor, so it is a
// `motion` device. The "Accelerated" status bit (bytes[3] & 0x01) of the
// Device_State and Acceleration_Data frames is published as
// action.motion.detected. The Device_State frame also carries a cumulative
// 16-bit Activation_count, published as action.motion.count. Tilt area bits and
// angle are device-specific orientation diagnostics and are emitted as
// camelCase extras (tiltArea0..2, angle). The device has no reed/contact, so no
// action.contactState is produced.

var TX_REASON = [
  'Undefined',
  'Button Pressed',
  'Heartbeat',
  'Settings',
  'Joined',
  'Acceleration',
  'Tilt',
  'Ongoing Acceleration',
  'Inactivity',
  'Error'
];

var FRAME_TYPE = [
  'Device_Info',
  'Device_State',
  'Acceleration_Data',
  'Button_Pressed',
  'Config_Data'
];

var DEVICE_MODES = ['Acceleration', 'Tilt'];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (port !== 10) {
    return { errors: ['unsupported FPort (expected 10)'] };
  }
  if (bytes.length < 3) {
    return { errors: ['header requires at least 3 bytes'] };
  }

  var frameType = FRAME_TYPE[bytes[1]];
  if (frameType === undefined) {
    return { errors: ['unknown frame type ' + bytes[1]] };
  }

  var data = {};
  // Supply voltage: byte * 10 mV -> volts.
  data.battery = round((bytes[0] * 10) / 1000, 2);
  data.frameType = frameType;
  data.txReason = TX_REASON[bytes[2]] !== undefined ? TX_REASON[bytes[2]] : 'Unknown';

  if (frameType === 'Device_Info') {
    if (bytes.length < 11) {
      return { errors: ['truncated Device_Info frame'] };
    }
    data.blVersion = bytes[3] + '.' + bytes[4] + '.' + bytes[5];
    data.fwVersion = bytes[6] + '.' + bytes[7] + '.' + bytes[8];
    data.hwRevision = (bytes[9] << 8) | bytes[10];
  } else if (frameType === 'Device_State') {
    if (bytes.length < 7) {
      return { errors: ['truncated Device_State frame'] };
    }
    data.action = {
      motion: {
        detected: !!(bytes[3] & 0x01),
        count: (bytes[5] << 8) | bytes[6]
      }
    };
    data.tiltArea0 = !!(bytes[3] & 0x10);
    data.tiltArea1 = !!(bytes[3] & 0x20);
    data.tiltArea2 = !!(bytes[3] & 0x40);
    data.angle = bytes[4];
  } else if (frameType === 'Acceleration_Data') {
    if (bytes.length < 5) {
      return { errors: ['truncated Acceleration_Data frame'] };
    }
    data.action = { motion: { detected: !!(bytes[3] & 0x01) } };
    data.tiltArea0 = !!(bytes[3] & 0x10);
    data.tiltArea1 = !!(bytes[3] & 0x20);
    data.tiltArea2 = !!(bytes[3] & 0x40);
    data.angle = bytes[4];
  } else if (frameType === 'Button_Pressed') {
    if (bytes.length < 4) {
      return { errors: ['truncated Button_Pressed frame'] };
    }
    data.buttonCount = bytes[3];
  } else if (frameType === 'Config_Data') {
    if (bytes.length < 10) {
      return { errors: ['truncated Config_Data frame'] };
    }
    var mode = '';
    for (var i = 0; i < 8; i++) {
      if ((bytes[3] >> i) & 1) {
        if (DEVICE_MODES[i] !== undefined) {
          mode += DEVICE_MODES[i];
        }
      }
    }
    data.deviceMode = mode;
    data.sensorThreshold = bytes[4];
    data.range = bytes[5];
    data.alpha = bytes[6];
    data.beta = bytes[7];
    data.hysteresis = bytes[8];
    data.sensCycleMinutes = bytes[9] * 6;
  }

  return { data: data };
}
