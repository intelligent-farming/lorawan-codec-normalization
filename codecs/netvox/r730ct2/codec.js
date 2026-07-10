// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R730CT2 (Wireless 2-Gang Thermocouple
// Interface, T type). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718b2.js, shared by
// the R718B2/R718Cx2/R730Cx2 thermocouple-interface family and attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// The R730CT2 is a two-channel T-type thermocouple interface: each data frame
// carries two independent temperature readings. The primary channel (Temp1) is
// reported as the top-level vocabulary key `temperature`; the second channel
// (Temp2) is the camelCase extra `temperature2` (both °C).
//
// fPort 6 frame layout (device id byte[1] == 0x7A for R730CT2):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x7A == R730CT2)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4..5]   channel-1 temperature, 16-bit big-endian signed, in 0.1 °C
//                 -> `temperature` (°C; raw / 10)
//   bytes[6..7]   channel-2 temperature, 16-bit big-endian signed, in 0.1 °C
//                 -> `temperature2` (°C; raw / 10)
//
// Config responses (fPort 7) and calibration responses (fPort 14) carry no
// measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  var v = (hi << 8) | lo;
  if (v & 0x8000) {
    v -= 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (configuration response, no measurement)'] };
  }
  if (input.fPort === 14) {
    return { errors: ['unsupported fPort 14 (calibration response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x7A) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x7a, R730CT2)'] };
  }

  // bytes[2] is the report-type discriminator; 0x00 is a device-info frame.
  if (bytes[2] === 0x00) {
    return { errors: ['device information frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4..5: channel-1 thermocouple temperature (0.1 °C, signed).
  data.temperature = round(signed16(bytes[4], bytes[5]) / 10, 1);

  // Bytes 6..7: channel-2 thermocouple temperature (0.1 °C, signed).
  data.temperature2 = round(signed16(bytes[6], bytes[7]) / 10, 1);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r730ct2";
  }
  return result;
}
