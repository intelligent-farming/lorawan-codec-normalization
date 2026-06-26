// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for netvox/ra0710 (Netvox RA0710 wireless water-
// turbidity + temperature sensor). Original work; wire format from the
// documented Netvox LoRaWAN Application Command ReportDataCmd (attributed in
// NOTICE), cross-checked against an independent community decoder.
//
// fPort 6 ReportDataCmd: b0 version 0x01; b1 device type 0x05; b2 report type
// 0x09 (turbidity). b3 battery 0.1 V (high bit low-battery -> lowBattery
// extra); b4..5 turbidity x10 -> water.turbidity (NTU); b6..7 water temperature
// x100 signed -> water.temperature.current; b8..9 auxiliary humidity x100 ->
// auxHumidity extra. 0xFFFF marks an absent field. Report type 0x00 (version)
// and other fPorts return an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }
function absent(hi, lo) { return (hi & 0xff) === 0xff && (lo & 0xff) === 0xff; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 6) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, ReportDataCmd)'] }; }
  if (!b || b.length < 10) { return { errors: ['expected at least 10 bytes, got ' + (b ? b.length : 0)] }; }
  if (b[2] === 0x00) { return { errors: ['version frame (no measurement)'] }; }
  if (b[1] !== 0x05 || b[2] !== 0x09) { return { errors: ['not an RA0710 turbidity report (device 0x05, type 0x09)'] }; }
  var data = { water: {} };
  data.battery = round((b[3] & 0x7f) / 10, 1);
  if (b[3] & 0x80) { data.lowBattery = true; }
  if (!absent(b[4], b[5])) { data.water.turbidity = round(u16(b[4], b[5]) / 10, 2); }
  if (!absent(b[6], b[7])) { data.water.temperature = { current: round(s16(b[6], b[7]) / 100, 2) }; }
  if (!absent(b[8], b[9])) { data.auxHumidity = round(u16(b[8], b[9]) / 100, 2); }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "netvox"; result.data.model = "ra0710"; }
  return result;
}
