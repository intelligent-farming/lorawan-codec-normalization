// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311FC (Wireless Activity Timer /
// run-time meter), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/r311fc-codec.yaml, codec
// payload/r311fc_r718mbc_r730mbc.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries reports; bytes[2] is the report-type discriminator. When
// bytes[2] == 0x00 the frame is a device-info report (device name, SW/HW
// version, datecode) and carries no measurement, so it is reported as an
// error. Otherwise the frame is a status report: bytes[3] is battery voltage
// in 0.1 V (high bit flags low battery, surfaced as the camelCase extra
// `lowBattery`); bytes[4..7] are a 32-bit big-endian cumulative work-duration
// counter in SECONDS, mapped to device.runtime. fPort 7 carries config
// request/response frames (no measurement) and is reported as an error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['config frame on fPort 7 (no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + bytes.length] };
  }

  if (bytes[2] === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4..7: 32-bit big-endian cumulative work-duration counter, in
  // seconds. >>> 0 keeps the value unsigned.
  var runtime = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;

  data.device = { runtime: runtime };

  return { data: data };
}
