// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718DB2 (Wireless 2-Gang Vibration
// Sensor, Spring Type), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/r718da2_r718db2_r718f2.js, attributed in NOTICE).
// Author the normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x3d == 61 == R718DB2) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`). This is a *2-gang* vibration
// sensor: bytes[4] is the gang-1 vibration status and bytes[5] the gang-2
// vibration status (upstream surfaces these as `status1` / `status2`). A
// non-zero gang status means that channel is currently detecting vibration.
// The combined vibration state maps to the `motion` category:
// action.motion.detected (boolean, true if either gang detects) and
// action.motion.count (the number of gangs currently detecting, 0-2). The raw
// per-gang status values are surfaced as the camelCase extras
// action.motion.gang1 / action.motion.gang2. Config responses (fPort 7) and
// the device-info frame carry no measurement and are reported as errors.

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

  // Bytes 4-5: per-gang vibration status. Non-zero => that gang is currently
  // detecting vibration.
  var gang1 = bytes[4];
  var gang2 = bytes[5];
  var count = 0;
  if (gang1 !== 0) {
    count = count + 1;
  }
  if (gang2 !== 0) {
    count = count + 1;
  }

  data.action = {
    motion: {
      detected: count !== 0,
      count: count,
      gang1: gang1,
      gang2: gang2
    }
  };

  return { data: data };
}
