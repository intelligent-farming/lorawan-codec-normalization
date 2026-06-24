// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elspina/em-elst01 (Elspina EM-ELST01).
// A Dragino LDS01-family door/switch sensor with an added 3-axis
// accelerometer and a DS18B20 temperature probe.
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elspina/em-elst01.js, attributed in
// NOTICE). The wire format and conversions are faithful to upstream; the
// normalized output is authored here per the shared vocabulary.
//
// Category: contact. The 4-bit `status` field carries the switch/door
// open-closed state -> action.contactState. The device exposes no discrete
// movement/shock event and no movement count: ALARM is a door-open-timeout
// alarm and TNOMD is a count of door-open events (NOT motion), and the X/Y/Z
// axes are raw acceleration with no derived event. Those are kept as extras.
//
// Frame lengths (fPort 2):
//   4 bytes  : status, battery, openCount (TNOMD)
//   9 bytes  : status, battery, totalOpenDuration (TODE),
//              lastOpenDuration (LDOD), alarm
//   19 bytes : all of the above plus accelX/Y/Z and DS18B20 air.temperature

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Signed 16-bit big-endian value as used by the accelerometer/temperature
// fields: upstream tests the high nibble == 0x0F to detect the negative range
// and subtracts 0xFFFF (matching upstream exactly).
function signed16(hi, lo) {
  var value = (hi << 8) | lo;
  if ((hi >> 4) === 0x0F) {
    return value - 0xFFFF;
  }
  return value;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || (bytes.length !== 4 && bytes.length !== 9 && bytes.length !== 19)) {
    return { errors: ['unsupported payload length'] };
  }

  var switchStatus = (bytes[0] >> 4) & 0x0F;
  var batV = (((bytes[0] << 8) | bytes[1]) & 0x0FFF) / 1000;

  var data = {
    battery: round(batV, 3),
    // status low bit is the door/switch state; 1 = open, 0 = closed.
    action: { contactState: (switchStatus & 0x01) ? 'open' : 'closed' },
    switchStatus: switchStatus
  };

  if (bytes.length === 4) {
    data.openCount = ((bytes[2] << 8) | bytes[3]) & 0xFFFF;
    return { data: data };
  }

  if (bytes.length === 9) {
    data.totalOpenDuration = ((bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) & 0xFFFFFF;
    data.lastOpenDuration = ((bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) & 0xFFFFFF;
    data.alarm = bytes[8];
    return { data: data };
  }

  // bytes.length === 19
  data.totalOpenDuration = ((bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) & 0xFFFFFF;
  data.lastOpenDuration = ((bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) & 0xFFFFFF;
  data.alarm = bytes[8];
  data.openCount = ((bytes[9] << 8) | bytes[10]) & 0xFFFF;
  data.accelX = round(signed16(bytes[11], bytes[12]) / 100, 2);
  data.accelY = round(signed16(bytes[13], bytes[14]) / 100, 2);
  data.accelZ = round(signed16(bytes[15], bytes[16]) / 100, 2);

  var temp = round(signed16(bytes[17], bytes[18]) / 10, 1);
  data.air = { temperature: temp };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elspina";
    result.data.model = "em-elst01";
  }
  return result;
}
