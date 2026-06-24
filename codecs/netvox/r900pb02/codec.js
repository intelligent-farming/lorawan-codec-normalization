// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900PB02, data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900pb02.js, shared by
// R900PB02 and R900PB02O1, attributed in NOTICE). Author the normalization here;
// do NOT copy upstream normalizeUplink.
//
// IMPORTANT — the source-of-truth codec does NOT match the marketing name. The
// shared r900pb02.js decoder is a soil/moisture-sensor frame: fPort 22 status
// reports carry soil VWC, soil temperature and soil EC plus a shock/tamper
// alarm. There is no contact/door state and no air temperature anywhere in any
// uplink measurement. We therefore normalize the real wire format faithfully.
//
// fPort 22: bytes[0] frame version, bytes[1..2] 16-bit big-endian device type
// (0x0107 == 263 == R900PB02), bytes[3] report-type discriminator. reportType
// 0x00 is a device-info/startup frame (sw/hw version + datecode), carries no
// measurement -> error. For a status frame: bytes[4] battery voltage in 0.1 V
// (high bit flags low battery, surfaced as the camelCase extra `lowBattery`) ->
// battery (V); bytes[5..6] soil moisture in 0.01 % -> soil.moisture; bytes[7..8]
// soil temperature in 0.01 C two's-complement -> soil.temperature; bytes[9..10]
// soil EC in 0.001 dS/m -> soil.ec; bytes[11] is a 6-bit threshold-alarm bitmap
// (low/high VWC, temperature, EC) surfaced as camelCase extras; bytes[12] is the
// shock/tamper alarm (0x00 == no alarm, non-zero == alarm) -> action.motion
// (detected) and the camelCase extra `tamperAlarm`. Config responses (fPort 23)
// carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeSoilTemperature(hi, lo) {
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

  var soil = {};
  // Bytes 5..6: soil moisture (VWC) in 0.01 %.
  soil.moisture = round(((bytes[5] << 8) | bytes[6]) / 100, 2);
  // Bytes 7..8: soil temperature in 0.01 C, two's-complement.
  soil.temperature = decodeSoilTemperature(bytes[7], bytes[8]);
  // Bytes 9..10: soil electrical conductivity in 0.001 dS/m.
  soil.ec = round(((bytes[9] << 8) | bytes[10]) / 1000, 3);
  data.soil = soil;

  // Byte 11: 6-bit threshold-alarm bitmap. Categorical -> camelCase extras.
  var flags = bytes[11];
  data.lowMoistureAlarm = flags & 0x01 ? true : false;
  data.highMoistureAlarm = flags >> 1 & 0x01 ? true : false;
  data.lowTemperatureAlarm = flags >> 2 & 0x01 ? true : false;
  data.highTemperatureAlarm = flags >> 3 & 0x01 ? true : false;
  data.lowEcAlarm = flags >> 4 & 0x01 ? true : false;
  data.highEcAlarm = flags >> 5 & 0x01 ? true : false;

  // Byte 12: shock/tamper alarm. Movement/disturbance of the node -> motion.
  var tampered = bytes[12] !== 0x00;
  data.action = {
    motion: { detected: tampered }
  };
  data.tamperAlarm = tampered;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900pb02";
  }
  return result;
}
