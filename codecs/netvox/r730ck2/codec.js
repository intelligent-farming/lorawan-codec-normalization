// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for netvox/r730ck2 (Netvox R730CK2, Wireless 2-Gang
// Thermocouple Interface, K type). Wire format from the upstream Apache-2.0
// Netvox decoder (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/r718b2.js — the single decoder shared by the whole
// 2-gang R718x2 / R730Cx2 family, attributed in NOTICE), cross-checked as
// oracle; the normalization is authored here.
//
// fPort 6 ReportDataCmd: b0 version 0x01; b1 device type 0x79 (R730CK2); b2
// report type (0x00 = version frame, no measurement); b3 battery in 0.1 V (high
// bit flags low battery -> lowBattery extra); b4..5 gang-1 temperature, 16-bit
// big-endian signed, 0.1 °C; b6..7 gang-2 temperature, same encoding.
//
// Netvox calls the interface's two thermocouple terminals "gangs". They are
// sub-sensor positions of one device, so their readings ride in the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") rather than in a
// suffixed `temperature2` extra: one entry per gang, labelled with the vendor's
// own term plus a zero-based index — `gang0` (b4..5) and `gang1` (b6..7) — each
// carrying the `temperature` vocabulary key in °C (raw / 10, rounded to 2
// decimals, i.e. the sensor's own 0.1 °C resolution). `battery` and the
// `lowBattery` flag are whole-device readings and stay top-level; no leaf is
// emitted in both places.
//
// Sentinel policy: this frame format defines NO disconnected-gang sentinel.
// Neither the shared upstream decoder nor the ReportDataCmd layout reserves a
// "no thermocouple" value — both gang words are plain two's-complement 0.1 °C
// readings across the K-type range — so no value is treated as a sentinel and
// neither gang entry is ever suppressed on its reading. The only omitted entry
// is structural: a ReportDataCmd truncated before b6..7 carries no gang-2 word,
// so `gang1` gets no entry rather than a fabricated 0 °C.
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
  var gangs = [{ channel: 'gang0', temperature: round(s16(b[4], b[5]) / 10, 2) }];
  if (b.length >= 8) { gangs.push({ channel: 'gang1', temperature: round(s16(b[6], b[7]) / 10, 2) }); }
  data.channels = gangs;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "netvox"; result.data.model = "r730ck2"; }
  return result;
}
