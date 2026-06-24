// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718WB2 (Wireless Water Leak Sensor,
// 2-probe cable/rope variant), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox, shared payload/r311w.js
// dispatch, attributed in NOTICE). Author the normalization here; do NOT copy
// upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x47 == 71 == R718WB2) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement -> error. For a
// measurement frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`). The R718WB2 has two
// leak probes: bytes[4] is probe 1 and bytes[5] is probe 2 (0x00 == no leak,
// non-zero == leak). The normalized boolean water.leak is the any-probe OR of
// the two probes (true if either probe detects a leak); the per-probe booleans
// are surfaced as the camelCase extras `leak1` / `leak2`. This device reports
// no temperature. Config responses (fPort 7) and any other fPort carry no
// measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
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

  // Bytes 4-5: per-probe leak state (0x00 == no leak, non-zero == leak).
  var leak1 = bytes[4] !== 0x00;
  var leak2 = bytes[5] !== 0x00;
  data.leak1 = leak1;
  data.leak2 = leak2;

  data.water = {
    // Normalized any-probe leak: true if either probe detects a leak.
    leak: leak1 || leak2
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718wb2";
  }
  return result;
}
