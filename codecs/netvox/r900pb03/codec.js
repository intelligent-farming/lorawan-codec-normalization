// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900PB03 (door/contact + shock sensor
// with an ultrasonic distance reading), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900pb03.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0108 == 264 == R900PB03) and bytes[3]
// the report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
//
// For a status frame:
//   byte 4: battery voltage in 0.1 V (high bit flags low battery, surfaced as
//           the camelCase extra `lowBattery`) -> battery (V).
//   byte 5: contact point state. Upstream reports 0x00 -> "Off", 0x01 -> "On".
//           "On" means the contact point is engaged/made, "Off" released
//           -> action.contactState "closed" (On) / "open" (Off). Any other value
//           leaves contactState unreported.
//   bytes 6..7: 16-bit big-endian distance reading in mm -> camelCase extra
//           `distanceMm` (no vocabulary home for a distance/ranging value).
//   byte 8: fill level percent (derived from distance) -> camelCase extra
//           `fillLevelPercent`.
//   byte 9: distance/fill threshold-alarm bitmap -> camelCase boolean extras.
//   byte 10: shock/tamper alarm state. Upstream 0x01 -> "Alarm", 0x00 ->
//           "NoAlarm" -> action.motion.detected (boolean).
//
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
  if (bytes.length < 4) {
    return { errors: ['expected at least 4 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[3];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var data = {};
  var action = {};

  // Byte 4: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[4] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[4] & 0x7f) / 10, 1);

  // Byte 5: contact point state. 0x01 (On) -> engaged/closed, 0x00 (Off) ->
  // released/open. Other values leave contactState unreported.
  if (bytes[5] === 0x01) {
    action.contactState = 'closed';
  } else if (bytes[5] === 0x00) {
    action.contactState = 'open';
  }

  // Byte 10: shock/tamper alarm -> motion detected (boolean).
  action.motion = {
    detected: bytes[10] !== 0x00
  };

  data.action = action;

  // Bytes 6..7: ultrasonic distance reading in mm (no vocabulary home).
  data.distanceMm = (bytes[6] << 8) | bytes[7];

  // Byte 8: fill level percent (derived from distance).
  data.fillLevelPercent = bytes[8];

  // Byte 9: distance/fill threshold-alarm bitmap.
  data.lowDistanceAlarm = (bytes[9] & 0x01) ? true : false;
  data.highDistanceAlarm = ((bytes[9] >> 1) & 0x01) ? true : false;
  data.lowFillLevelAlarm = ((bytes[9] >> 2) & 0x01) ? true : false;
  data.highFillLevelAlarm = ((bytes[9] >> 3) & 0x01) ? true : false;

  return { data: data };
}
