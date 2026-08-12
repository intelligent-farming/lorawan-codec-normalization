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
// The R730CT2 is a two-gang T-type thermocouple interface: each data frame
// carries two independent temperature readings. Netvox calls the two terminals
// "gangs"; they are sub-sensor positions of one device, so their readings ride
// in the reserved `channels` array (see AUTHORING.md "Multi-channel devices")
// rather than in a suffixed `temperature2` extra. One entry per gang, labelled
// with the vendor's own term plus a zero-based index — `gang0` (Temp1, bytes
// 4..5) and `gang1` (Temp2, bytes 6..7) — each carrying the `temperature`
// vocabulary key in °C. `battery` and the `lowBattery` flag are whole-device
// readings and stay top-level; no leaf is emitted in both places.
//
// fPort 6 frame layout (device id byte[1] == 0x7A for R730CT2):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x7A == R730CT2)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4..5]   gang-1 temperature, 16-bit big-endian signed, in 0.1 °C
//                 -> channels[gang0].temperature (°C; raw / 10)
//   bytes[6..7]   gang-2 temperature, 16-bit big-endian signed, in 0.1 °C
//                 -> channels[gang1].temperature (°C; raw / 10)
//
// Sentinel policy: this frame format defines NO disconnected-gang sentinel.
// Neither the shared upstream decoder nor the frame layout reserves a "no
// thermocouple" value — both gang words are plain two's-complement 0.1 °C
// readings across the T-type range — so no value is treated as a sentinel and
// neither gang entry is ever suppressed on its reading. Frames shorter than 8
// bytes (which could not carry both gang words) are rejected outright by the
// length check below, so a data frame always yields both entries.
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

  // One channels entry per gang: bytes 4..5 = gang0 (Temp1), bytes 6..7 = gang1
  // (Temp2), both signed 0.1 °C thermocouple readings.
  data.channels = [
    { channel: 'gang0', temperature: round(signed16(bytes[4], bytes[5]) / 10, 1) },
    { channel: 'gang1', temperature: round(signed16(bytes[6], bytes[7]) / 10, 1) }
  ];

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
