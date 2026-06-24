// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718DA2 (Wireless 2-Gang Vibration
// Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da2_r718db2_r718f2.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x2F == 47 == R718DA2) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a status
// (measurement) frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`). The R718DA2 has two
// external rolling-ball vibration sensors; bytes[4] (status1) and bytes[5]
// (status2) are the two gang/channel vibration states (non-zero == vibration
// detected on that channel). These map to action.motion: `detected` is true if
// either channel reports vibration, and `count` is the number of channels
// currently detecting vibration (0..2). The per-channel raw states are also
// surfaced as the camelCase extras `vibration1`/`vibration2`. Config responses
// (fPort 7) carry no measurement and are reported as errors.

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

  // Bytes 4-5: per-channel vibration state for the two rolling-ball sensors.
  // Non-zero == vibration detected on that channel.
  var v1 = bytes[4];
  var v2 = bytes[5];
  data.vibration1 = v1;
  data.vibration2 = v2;

  var count = 0;
  if (v1) {
    count = count + 1;
  }
  if (v2) {
    count = count + 1;
  }

  data.action = {
    motion: {
      detected: count > 0,
      count: count
    }
  };

  return { data: data };
}
