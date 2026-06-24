// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox RA02C (Wireless CO Detector), data report
// on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/ra02c.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// The RA02C is an alarm-only CO (carbon monoxide) safety detector: it reports a
// categorical alarm state, not a CO concentration. fPort 6 carries periodic
// data reports: bytes[1] is the device type (0x11 == 17 == RA02C) and bytes[2]
// is the report-type discriminator. reportType 0x00 is a device-info/startup
// frame (software/hardware version + datecode) and carries no measurement, so
// it is reported as an error. For a status (measurement) frame, bytes[3] is
// battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`), bytes[4] is the CO alarm state (0x00 = no
// alarm, non-zero = alarm) mapped to air.gasAlarm (boolean), and bytes[5] is
// the high-temperature alarm state (0x00 = no alarm, non-zero = alarm) surfaced
// as the camelCase extra `highTempAlarm`. The monitored gas is fixed CO,
// surfaced as the camelCase extra `gasType`. This device emits no temperature
// reading, so air.temperature is not produced. Config responses (fPort 7) carry
// no measurement and are reported as errors.

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

  // Byte 4: CO alarm state (0x00 = no alarm, non-zero = alarm).
  // Byte 5: high-temperature alarm state (0x00 = no alarm, non-zero = alarm).
  data.air = {
    gasAlarm: bytes[4] !== 0x00
  };
  data.gasType = 'CO';
  data.highTempAlarm = bytes[5] !== 0x00;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "ra02c";
  }
  return result;
}
