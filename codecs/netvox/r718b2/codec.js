// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for netvox/r718b2 (Netvox R718B2 2-Channel Temperature Sensor). Wire format from
// the upstream Apache-2.0 Netvox decoder (TheThingsNetwork/lorawan-devices
// vendor/netvox, attributed in NOTICE), cross-checked as oracle; the
// normalization is authored here.
//
// fPort 6 ReportDataCmd: b0 version 0x01; b1 device type 0xe; b2 report type
// (0x00 = version frame, no measurement). b3 battery 0.1 V (high bit low-battery
// -> lowBattery extra); b4..5 temperature signed/10 -> temperature; b6..7 second probe signed/10 -> temperature2 extra.
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
  data.temperature2 = round(s16(b[6], b[7]) / 10, 2);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "netvox"; result.data.model = "r718b2"; }
  return result;
}
