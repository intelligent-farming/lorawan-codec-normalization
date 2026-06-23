// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900PB03O1 (Wireless Contact + Distance +
// Shock/ShockTamper Sensor with dry-contact point output), data report on
// fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900pb03.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0110 == 272 == R900PB03O1) and bytes[3]
// the report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame:
//   byte 4  : battery voltage in 0.1 V; high bit flags low battery -> battery (V)
//             plus the camelCase extra `lowBattery`.
//   byte 5  : dry-contact point / reed state (0x00 == Off, 0x01 == On). A dry
//             contact reads On == circuit closed, Off == circuit open ->
//             action.contactState ('open' | 'closed').
//   byte 6-7: ultrasonic distance in mm (big-endian) -> camelCase extra `distance`.
//   byte 8  : fill level in percent -> camelCase extra `fillLevel`.
//   byte 9  : distance/fill threshold-alarm bitmap -> camelCase extras.
//   byte 10 : shock/tamper alarm (0x00 == NoAlarm, non-zero == Alarm). Shock is
//             movement -> action.motion.detected; the same flag is also a tamper
//             indicator, surfaced as the camelCase extra `tamperAlarm`.
// Config responses (fPort 23) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[3];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 4: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[4] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[4] & 0x7f) / 10, 1);

  // Byte 5: dry-contact point / reed state. On (0x01) == closed, Off (0x00) == open.
  var action = {};
  action.contactState = bytes[5] === 0x00 ? 'open' : 'closed';

  // Byte 10: shock/tamper alarm. Shock is movement -> motion.detected.
  action.motion = {
    detected: bytes[10] !== 0x00
  };
  data.action = action;

  // Byte 10 also doubles as a tamper indicator (categorical extra).
  data.tamperAlarm = bytes[10] !== 0x00;

  // Bytes 6-7: ultrasonic distance in mm (big-endian).
  data.distance = (bytes[6] << 8) | bytes[7];

  // Byte 8: fill level in percent.
  data.fillLevel = bytes[8];

  // Byte 9: distance/fill threshold-alarm bitmap.
  var flags = bytes[9];
  data.lowDistanceAlarm = flags & 0x01 ? true : false;
  data.highDistanceAlarm = flags >> 1 & 0x01 ? true : false;
  data.lowFillLevelAlarm = flags >> 2 & 0x01 ? true : false;
  data.highFillLevelAlarm = flags >> 3 & 0x01 ? true : false;

  return { data: data };
}
