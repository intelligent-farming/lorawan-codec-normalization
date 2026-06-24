// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900NAC3 (Shock / ShockTamper sensor with
// current monitoring), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900nac3.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0101 == 257 == R900NAC3) and bytes[3] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame: bytes[4] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`) -> battery (V);
// bytes[5..7], bytes[8..10], bytes[11..13] are three 24-bit big-endian current
// readings in mA (vendor diagnostics, surfaced as camelCase extras
// `current1`/`current2`/`current3`); bytes[14] is a bitmap of low/high current
// threshold-alarm flags (categorical, surfaced as camelCase extras); bytes[15] is
// the shock/tamper alarm state (0x00 == NoAlarm, non-zero == Alarm). This is a
// shock/movement sensor, so the alarm maps to action.motion.detected, and the
// same flag is also surfaced as the camelCase extra `tamperAlarm`. Config
// responses (fPort 23) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 16) {
    return { errors: ['expected at least 16 bytes, got ' + bytes.length] };
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

  // Bytes 5..7 / 8..10 / 11..13: three 24-bit big-endian currents in mA.
  data.current1 = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  data.current2 = (bytes[8] << 16) | (bytes[9] << 8) | bytes[10];
  data.current3 = (bytes[11] << 16) | (bytes[12] << 8) | bytes[13];

  // Byte 14: current threshold-alarm bitmap. Categorical, surfaced as extras.
  var flags = bytes[14];
  data.lowCurrent1Alarm = flags & 0x01 ? true : false;
  data.highCurrent1Alarm = flags >> 1 & 0x01 ? true : false;
  data.lowCurrent2Alarm = flags >> 2 & 0x01 ? true : false;
  data.highCurrent2Alarm = flags >> 3 & 0x01 ? true : false;
  data.lowCurrent3Alarm = flags >> 4 & 0x01 ? true : false;
  data.highCurrent3Alarm = flags >> 5 & 0x01 ? true : false;

  // Byte 15: shock/tamper alarm state. Shock/movement -> action.motion.detected;
  // the tamper flag is also surfaced as the camelCase extra `tamperAlarm`.
  var alarm = bytes[15] !== 0x00;
  data.action = {
    motion: {
      detected: alarm
    }
  };
  data.tamperAlarm = alarm;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900nac3";
  }
  return result;
}
