// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox RA02D1 (Wireless LPG / Combustible-Gas
// Detector with temperature), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/ra02d1.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// The RA02D1 is an alarm-only LPG / combustible-gas safety detector: it reports
// a categorical alarm state, not a gas concentration. fPort 6 carries periodic
// data reports: bytes[1] is the device type (0xD6 == 214 == RA02D1) and
// bytes[2] is the report-type discriminator. reportType 0x00 is a
// device-info/startup frame (software/hardware version + datecode) and carries
// no measurement, so it is reported as an error. For a status (measurement)
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`), bytes[4] is the LPG alarm
// state (0x00 = no alarm, non-zero = alarm) mapped to air.gasAlarm (boolean),
// bytes[5] is the high-temperature alarm state (0x00 = no alarm, non-zero =
// alarm) surfaced as the camelCase extra `highTempAlarm`, and bytes[6..7] are
// the temperature in 0.1 C, signed two's-complement, mapped to air.temperature.
// The monitored gas is fixed LPG, surfaced as the camelCase extra `gasType`.
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeTemperature(hi, lo) {
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return round(raw / 10, 1);
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + bytes.length] };
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

  // Byte 4: LPG alarm state (0x00 = no alarm, non-zero = alarm).
  // Byte 5: high-temperature alarm state (0x00 = no alarm, non-zero = alarm).
  // Bytes 6..7: temperature in 0.1 C, signed two's-complement.
  data.air = {
    gasAlarm: bytes[4] !== 0x00,
    temperature: decodeTemperature(bytes[6], bytes[7])
  };
  data.gasType = 'LPG';
  data.highTempAlarm = bytes[5] !== 0x00;

  return { data: data };
}
