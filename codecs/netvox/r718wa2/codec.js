// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718WA2 (Wireless Water Leak Sensor,
// 2-probe variant), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r311w.js, the shared
// family decoder that also handles deviceType 0x46 = 70 = R718WA2; attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports. bytes[0] is the protocol version,
// bytes[1] the device type (0x46 = 70 = R718WA2), bytes[2] the report-type
// discriminator. Report type 0x00 is the device-info / startup frame (software
// version, hardware version, datecode) and carries no measurement. For a status
// report: bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`); bytes[4] and bytes[5] are the
// two leak-probe states (non-zero = leak detected). This 2-probe variant has no
// temperature/humidity sensor. The combined leak state water.leak is the OR of
// the two probes; the per-probe states are surfaced as the camelCase extras
// leak1 / leak2 under `water`. Config responses (fPort 7) carry no measurement
// and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
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

  // Bytes 4-5: per-probe leak state, non-zero = leak detected. The combined
  // water.leak is the OR of the two probes; per-probe states are extras.
  var leak1 = bytes[4] ? true : false;
  var leak2 = bytes[5] ? true : false;
  data.water = {
    leak: leak1 || leak2,
    leak1: leak1,
    leak2: leak2
  };

  return { data: data };
}
