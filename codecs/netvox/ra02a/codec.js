// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox RA02A (Wireless Smoke Detector).
// Data reports arrive on fPort 6.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/ra02a.js, attributed
// in NOTICE). Normalization authored here; upstream decodeUplink is NOT copied.
//
// fPort 6 frame layout (device id byte[1] == 0x0A for RA02A):
//   bytes[0]      report/frame marker (0x01)
//   bytes[1]      device type id (0x0A == RA02A)
//   bytes[2]      report type; 0x00 is a version/date-code frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      fire (smoke) alarm; nonzero -> action.smoke.detected = true
//   bytes[5]      high-temperature alarm; nonzero -> extra highTempAlarm = true
//   bytes[6..7]   temperature, 16-bit big-endian signed, in 0.1 °C
//                 -> air.temperature (°C; raw / 10)
// Config responses (fPort 7) carry no measurement and are reported as errors.

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
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x0A) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x0a, RA02A)'] };
  }
  if (bytes[2] === 0x00) {
    return { errors: ['device version frame (no measurement)'] };
  }

  var data = {};

  // Smoke (fire) alarm -> normalized boolean.
  data.action = { smoke: { detected: bytes[4] !== 0x00 } };

  // Battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // High-temperature alarm flag (device diagnostic).
  data.highTempAlarm = bytes[5] !== 0x00;

  // Onboard temperature reading (0.1 °C, signed).
  data.air = { temperature: round(signed16(bytes[6], bytes[7]) / 10, 1) };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "ra02a" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "ra02a";
  }
  return result;
}
