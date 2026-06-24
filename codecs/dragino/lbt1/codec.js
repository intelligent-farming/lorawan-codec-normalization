// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LBT1 (LoRaWAN BLE Tracker with
// motion/alarm).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lbt1.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// On-device motion state maps to the `motion` vocabulary: the alarm flag (a
// genuine device-decoded event) -> action.motion.detected, and the on-device
// pedometer/step counter -> action.motion.count. The BLE beacon scan fields
// (uuid/addr/major/minor/rssi) are cloud-solved positioning data, not on-device
// measurements, so they are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
  }

  var data = {};
  var i;
  var con;
  var str;

  // Bytes 0-1: battery voltage, millivolts -> volts.
  var battRaw = (bytes[0] << 8) | bytes[1];
  data.battery = round(battRaw / 1000, 3);

  // Byte 2 high nibble: alarm flag (on-device motion/alarm event).
  // Byte 2 low nibble + bytes 3-4: 20-bit step counter (on-device pedometer).
  var alarm = (bytes[2] >> 4) & 0x0f;
  var stepCount = ((bytes[2] & 0x0f) << 16) | (bytes[3] << 8) | bytes[4];

  data.action = {
    motion: {
      detected: alarm !== 0,
      count: stepCount
    }
  };

  // Byte 5: payload mode, selects how the BLE beacon scan fields are framed.
  var mode = bytes[5];
  var uuid = '';
  var addr = '';
  var major = 1;
  var minor = 1;
  var rssi = 0;

  if (mode === 1) {
    str = '';
    for (i = 6; i < 11 && i < bytes.length; i++) {
      con = bytes[i].toString();
      str += String.fromCharCode(con);
    }
    uuid = str;
  } else if (mode === 2) {
    str = '';
    for (i = 6; i < 38 && i < bytes.length; i++) {
      con = bytes[i].toString();
      str += String.fromCharCode(con);
    }
    uuid = str;

    str = '';
    for (i = 38; i < 50 && i < bytes.length; i++) {
      con = bytes[i].toString();
      str += String.fromCharCode(con);
    }
    addr = str;
  } else if (mode === 3) {
    str = '';
    for (i = 6; i < 18 && i < bytes.length; i++) {
      con = bytes[i].toString();
      str += String.fromCharCode(con);
    }
    uuid = str;

    str = '';
    for (i = 18; i < 22 && i < bytes.length; i++) {
      con = bytes[i].toString();
      str += String.fromCharCode(con);
    }
    major = parseInt(str, 16);

    str = '';
    for (i = 22; i < 26 && i < bytes.length; i++) {
      con = bytes[i].toString();
      str += String.fromCharCode(con);
    }
    minor = parseInt(str, 16);

    str = '';
    for (i = 28; i < 32 && i < bytes.length; i++) {
      con = bytes[i].toString();
      str += String.fromCharCode(con);
    }
    rssi = parseInt(str, 10);
  }

  // BLE beacon scan results: cloud-solved positioning, kept as extras.
  data.bleUuid = uuid;
  data.bleAddr = addr;
  data.bleMajor = major;
  data.bleMinor = minor;
  data.bleRssi = rssi;
  data.alarmFlag = alarm;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lbt1";
  }
  return result;
}
