// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900NDC (Shock / Shock-Tamper sensor with
// dual current sensing), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900ndc.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Despite the catalog name ("Wireless Water leak Sensor"), the R900NDC is a
// shock / movement sensor: the upstream decoder carries NO leak field. fPort 22
// carries device reports; bytes[1..2] are the 16-bit big-endian device type
// (0x0103 == 259 == R900NDC) and bytes[3] is the report-type discriminator.
// reportType 0x00 is a device-info/startup frame (software / hardware version +
// datecode) with no measurement -> error. For a status frame, bytes[4] is the
// battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`) -> battery (V); bytes[5..7] and bytes[8..10] are
// two 24-bit big-endian current readings in mA, surfaced as the camelCase extras
// `current1`/`current2`; bytes[11] packs four current threshold-alarm flags
// (camelCase extras); and bytes[12] is the shock/tamper alarm state (0x00 == no
// alarm, non-zero == alarm) -> action.motion.detected (the device's shock/
// movement event). Config responses (fPort 23) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 13) {
    return { errors: ['expected at least 13 bytes, got ' + bytes.length] };
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

  // Bytes 5..7 and 8..10: two 24-bit big-endian current readings (mA).
  data.current1 = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  data.current2 = (bytes[8] << 16) | (bytes[9] << 8) | bytes[10];

  // Byte 11: current threshold-alarm flags. Categorical, surfaced as extras.
  var flags = bytes[11];
  data.lowCurrent1Alarm = flags & 0x01 ? true : false;
  data.highCurrent1Alarm = flags >> 1 & 0x01 ? true : false;
  data.lowCurrent2Alarm = flags >> 2 & 0x01 ? true : false;
  data.highCurrent2Alarm = flags >> 3 & 0x01 ? true : false;

  // Byte 12: shock / shock-tamper alarm state. The device's movement event ->
  // action.motion.detected.
  data.action = {
    motion: {
      detected: bytes[12] !== 0x00
    }
  };

  return { data: data };
}
