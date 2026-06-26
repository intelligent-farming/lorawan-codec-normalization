// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/ps-lb-d (Dragino PS-LB-D/PS-LS-D
// differential-pressure transmitter, 4-20 mA current-loop probe). Authored from
// the upstream Apache-2.0 Dragino PS-LB v1.2 decoder (attributed in NOTICE);
// the PS-LB-D is the PS-LB node in probe mode 0x02 (differential pressure).
//
// fPort 2 measurement: battery (b0<<8|b1)/1000; probe mode b2 (0x02 =
// differential); range select b3; loop current IDC b4..5 /1000 (mA); supply
// VDC b6..7 /1000 (V). Differential pressure is (IDC - 4 mA) x a per-range
// scale from the Dragino transfer table, in Pa (ranges 10-12 subtract a 12 mA
// offset) -> pressure.differential (Pa). A faithful port of the upstream
// transform(); non-differential probe modes are surfaced without a
// pressure.differential key (and so do not satisfy this category).
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

function diffPa(rangeSel, idc) {
  if (idc <= 4.0) { return 0; }
  var d4 = idc - 4.0, d12 = idc - 12.0;
  if (rangeSel === 1) { return d4 * 6.25; }
  if (rangeSel === 2) { return d4 * 12.5; }
  if (rangeSel === 3) { return d4 * 18.75; }
  if (rangeSel === 4) { return d4 * 62.5; }
  if (rangeSel === 5) { return d4 * 125; }
  if (rangeSel === 6) { return d4 * 187.5; }
  if (rangeSel === 7) { return d4 * 250; }
  if (rangeSel === 8) { return d4 * 312.5; }
  if (rangeSel === 9) { return d4 * 625; }
  if (rangeSel === 10) { return d12 * 12.5; }
  if (rangeSel === 11) { return d12 * 25; }
  if (rangeSel === 12) { return d12 * 125; }
  return null;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort === 7) { return { errors: ['datalog history frame (fPort 7), not a live measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 9) { return { errors: ['payload too short (need >= 9 bytes)'] }; }
  var probeMode = b[2];
  var rangeSel = b[3];
  var idc = round((((b[4] & 0xff) << 8) | b[5]) / 1000, 3);
  var data = {};
  data.battery = round((((b[0] << 8) | b[1])) / 1000, 3);
  data.probeMode = probeMode;
  data.loopCurrent = idc;
  data.supplyVoltage = round((((b[6] & 0xff) << 8) | b[7]) / 1000, 3);
  data.in1PinHigh = (b[8] & 0x08) ? true : false;
  data.in2PinHigh = (b[8] & 0x04) ? true : false;
  data.extiPinHigh = (b[8] & 0x02) ? true : false;
  data.extiActive = (b[8] & 0x01) ? true : false;
  if (probeMode === 0x02) {
    var pa = diffPa(rangeSel, idc);
    if (pa !== null) { data.pressure = { differential: round(pa, 3) }; }
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "ps-lb-d"; }
  return result;
}
