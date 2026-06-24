// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900PD01 (Wireless Water-Quality Probe:
// pH / turbidity / residual chlorine + per-parameter water temperatures), data
// report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900pd01.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0106 == 262 == R900PD01) and bytes[3]
// the report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame:
//   bytes[4..5]   pH                       /100   -> water.ph
//   bytes[6..7]   temperature (with pH)    /100 C, two's-complement -> water.temperature.current
//   bytes[8..9]   turbidity                /10  NTU -> water.turbidity
//   bytes[10..11] temperature (with NTU)   /100 C, two's-complement -> extra temperatureNtu
//   bytes[12..13] residual chlorine        /100 mg/L -> water.residualChlorine
//   bytes[14..15] alarm bitmap (low/high per parameter) -> camelCase extras
//   bytes[16]     shock/tamper alarm (0x00 none, 0x01 alarm) -> extra tamperAlarm
// This device has no battery field in its data report, so `battery` is omitted.
// Config responses (fPort 23, ConfigReport / shock-sensitivity / dry-contact)
// carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeTemperature(hi, lo) {
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return round(raw / 100, 2);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 17) {
    return { errors: ['expected at least 17 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[3];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var water = {};

  // pH: bytes[4..5] / 100.
  water.ph = round(((bytes[4] << 8) | bytes[5]) / 100, 2);

  // Turbidity: bytes[8..9] / 10 (NTU).
  water.turbidity = round(((bytes[8] << 8) | bytes[9]) / 10, 1);

  // Residual chlorine: bytes[12..13] / 100 (mg/L).
  water.residualChlorine = round(((bytes[12] << 8) | bytes[13]) / 100, 2);

  // Water temperature measured with the pH probe -> current temperature.
  water.temperature = {
    current: decodeTemperature(bytes[6], bytes[7])
  };

  var data = {
    water: water
  };

  // Second per-parameter temperature (measured with the turbidity probe) is not
  // modelled by the vocabulary; surface it as a camelCase extra.
  data.temperatureNtu = decodeTemperature(bytes[10], bytes[11]);

  // Alarm bitmap (bytes[14] | bytes[15]); each bit is a low/high threshold flag.
  var flags = bytes[14] | bytes[15];
  data.lowPhAlarm = flags & 0x01 ? true : false;
  data.highPhAlarm = flags >> 1 & 0x01 ? true : false;
  data.lowTurbidityAlarm = flags >> 2 & 0x01 ? true : false;
  data.highTurbidityAlarm = flags >> 3 & 0x01 ? true : false;
  data.lowResidualChlorineAlarm = flags >> 4 & 0x01 ? true : false;
  data.highResidualChlorineAlarm = flags >> 5 & 0x01 ? true : false;
  data.lowTempWithPhAlarm = flags >> 6 & 0x01 ? true : false;
  data.highTempWithPhAlarm = flags >> 7 & 0x01 ? true : false;

  // Shock/tamper alarm: bytes[16], 0x00 == no alarm, non-zero == alarm.
  data.tamperAlarm = bytes[16] !== 0x00;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900pd01";
  }
  return result;
}
