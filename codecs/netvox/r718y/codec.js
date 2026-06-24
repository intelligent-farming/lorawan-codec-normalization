// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718Y (Wireless Differential Pressure and
// Temperature Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718y.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports; bytes[2] == 0x00 is a device-info
// (version) frame that carries no measurement and is reported as an error.
// Otherwise:
//   bytes[3]: battery voltage in 0.1 V; high bit flags low battery, surfaced as
//             the camelCase extra `lowBattery` (the flag bit then masked off).
//   bytes[4..5]: differential pressure, signed 16-bit, 0.1 Pa resolution. The
//             R718Y already reports a calibrated differential pressure in Pa
//             (datasheet unit), so the decoded value maps straight to
//             pressure.differential (Pa) with no further conversion.
//   bytes[6..7]: temperature, signed 16-bit, 0.1 C -> air.temperature (C).
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  // Upstream uses (0x10000 - raw) * -1 on the negative branch, which is the
  // exact two's-complement value; compute it directly.
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return raw;
}

function decodeUplink(input) {
  var bytes = input.bytes;

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

  // Bytes 4..5: signed differential pressure, 0.1 Pa -> Pa.
  data.pressure = { differential: round(signed16(bytes[4], bytes[5]) / 10, 1) };

  // Bytes 6..7: signed temperature, 0.1 C.
  data.air = { temperature: round(signed16(bytes[6], bytes[7]) / 10, 1) };

  return { data: data };
}
