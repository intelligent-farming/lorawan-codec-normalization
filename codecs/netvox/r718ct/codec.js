// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for netvox/r718ct (Netvox R718CT Thermocouple Temperature Sensor). Wire format from
// the upstream Apache-2.0 Netvox decoder (TheThingsNetwork/lorawan-devices
// vendor/netvox, attributed in NOTICE), cross-checked as oracle; the
// normalization is authored here.
//
// fPort 6 ReportDataCmd: b0 version 0x01; b1 device type 0x92; b2 report type
// (0x00 = version frame, no measurement). b3 battery 0.1 V (high bit low-battery
// -> lowBattery extra); b4..5 temperature signed/10 -> temperature.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 6) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, ReportDataCmd)'] }; }
  if (!b || b.length < 6) { return { errors: ['expected at least 6 bytes, got ' + (b ? b.length : 0)] }; }
  if (b[2] === 0x00) { return { errors: ['version frame (no measurement)'] }; }
  var data = {};
  data.battery = round((b[3] & 0x7f) / 10, 1);
  if (b[3] & 0x80) { data.lowBattery = true; }
  data.temperature = round(s16(b[4], b[5]) / 10, 2);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r718ct" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "netvox"; result.data.model = "r718ct"; }
  return result;
}
