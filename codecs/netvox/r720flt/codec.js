// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R720FLT (Wireless Toilet Water Tank
// Leakage Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r720flt.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0xD4 == 212 == R720FLT) and bytes[2] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement. For a
// status frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`), bytes[4..7] are a
// 32-bit big-endian replenish-water count (surfaced as the camelCase extra
// `replenishWaterCount`), bytes[8] is a fault flag (surfaced as the camelCase
// extra `fault`) and bytes[9] is the tank-leak flag -> water.leak (boolean,
// true = leak detected). Config responses (fPort 7) carry no measurement and
// are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4-7: cumulative replenish-water count, 32-bit big-endian.
  // Accumulated in floating point rather than with a 32-bit left shift
  // (which would overflow JS bitwise ops).
  data.replenishWaterCount = (bytes[4] * 16777216) + (bytes[5] * 65536) + (bytes[6] * 256) + bytes[7];

  // Byte 8: fault flag (non-zero == fault).
  data.fault = bytes[8] ? true : false;

  // Byte 9: tank-leak flag (non-zero == leak detected).
  data.water = {
    leak: bytes[9] ? true : false
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r720flt";
  }
  return result;
}
