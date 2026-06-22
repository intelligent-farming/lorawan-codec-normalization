// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LDS01 (Door Open/Close Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lds01.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// Wire format (fPort 10):
//   bytes[0..1]  battery, low 14 bits, millivolts -> volts (/1000)
//   bytes[0]     bit 0x80 = door open status (1 = open, 0 = closed)
//   bytes[2]     MOD (working mode); the LDS01 door sensor operates in mode 1
//   bytes[3..5]  door open event count (uint24)
//   bytes[6..8]  last door-open duration, minutes (uint24)
//   bytes[9]     bit 0x01 = alarm flag
//
// Mapping decisions:
//   DOOR_OPEN_STATUS (1=open,0=closed) -> action.contactState ('open'|'closed').
//     This is a contact (reed) sensor, so the state is emitted as
//     action.contactState and NOT as action.motion (a known upstream
//     copy-paste bug for door sensors).
//   door open event count                -> openCount extra (count)
//   last door-open duration (minutes)    -> lastOpenDurationMinutes extra
//   alarm flag                           -> alarm extra (boolean)
//   battery millivolts                   -> battery (volts)
//
// Upstream returns vendor-named keys (BAT_V, MOD, DOOR_OPEN_STATUS, etc.)
// directly; this module normalizes to the shared vocabulary plus camelCase
// extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 10)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
  }

  var mod = bytes[2];
  if (mod !== 1) {
    return { errors: ['unsupported MOD ' + mod + ' (expected 1, door mode)'] };
  }

  var data = {};
  var action = {};

  // Bytes 0-1: battery voltage, low 14 bits, millivolts -> volts.
  var battRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
  data.battery = round(battRaw / 1000, 3);

  // Byte 0 bit 0x80: door open status (1 = open, 0 = closed).
  var doorOpen = bytes[0] & 0x80 ? 1 : 0;
  action.contactState = doorOpen ? 'open' : 'closed';

  // Bytes 3-5: door open event count.
  var openCount = (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];

  // Bytes 6-8: last door-open duration, minutes.
  var openDuration = (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];

  // Byte 9 bit 0x01: alarm flag.
  var alarm = (bytes[9] & 0x01) === 1;

  data.action = action;
  data.openCount = openCount;
  data.lastOpenDurationMinutes = openDuration;
  data.alarm = alarm;

  return { data: data };
}
