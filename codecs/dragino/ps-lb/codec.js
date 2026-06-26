// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/ps-lb (Dragino PS-LB industrial pressure
// transmitter, 4-20 mA current-loop probe). Authored from the upstream
// Apache-2.0 Dragino decoder (attributed in NOTICE; upstream stores JS with
// escaped newlines).
//
// fPort 2 measurement: battery (b0<<8|b1)/1000; probe mode b2; range select b3;
// loop current IDC b4..5 /1000 (mA); supply VDC b6..7 /1000 (V). In pressure
// mode (probe mode 1) the gauge pressure is (IDC - 4 mA) x a per-range scale
// from the Dragino transfer table, in MPa (ranges 1-9) or kPa (ranges 10-12);
// normalized to pressure.gauge in kPa (MPa x 1000). The mA/range scaling is a
// faithful port of the upstream table; note the upstream references an
// undefined `decode.` object (a typo for its local data) which throws for
// non-zero pressure, so the computed mA value is used here.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

function gaugeKpa(rangeSel, idc) {
  if (idc <= 4.0) { return 0; }
  var d = idc - 4.0;
  // MPa-output ranges (x1000 -> kPa)
  if (rangeSel === 1) { return d * 0.0375 * 1000; }
  if (rangeSel === 2) { return d * 0.0625 * 1000; }
  if (rangeSel === 3) { return d * 0.1 * 1000; }
  if (rangeSel === 4) { return d * 0.15625 * 1000; }
  if (rangeSel === 5) { return d * 0.625 * 1000; }
  if (rangeSel === 6) { return d * 2.5 * 1000; }
  if (rangeSel === 7) { return d * 3.75 * 1000; }
  if (rangeSel === 8) { return d * -0.00625 * 1000; }
  if (rangeSel === 9) { return (idc <= 12.0 ? d * -0.0125 : (idc - 12.0) * 0.0125) * 1000; }
  // kPa-output ranges (already kPa)
  if (rangeSel === 10) { return d * 0.3125; }
  if (rangeSel === 11) { return d * 3.125; }
  if (rangeSel === 12) { return d * 6.25; }
  return null;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort === 7) { return { errors: ['datalog history frame (fPort 7), not a live measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 9) { return { errors: ['payload too short (need >= 9 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1])) / 1000, 3);
  var probeMode = b[2];
  var rangeSel = b[3];
  var idc = round((((b[4] & 0xff) << 8) | b[5]) / 1000, 3);
  var vdc = round((((b[6] & 0xff) << 8) | b[7]) / 1000, 3);
  data.probeMode = probeMode;
  data.loopCurrent = idc;
  data.supplyVoltage = vdc;
  data.in1PinHigh = (b[8] & 0x08) ? true : false;
  data.in2PinHigh = (b[8] & 0x04) ? true : false;
  data.extiPinHigh = (b[8] & 0x02) ? true : false;
  data.extiActive = (b[8] & 0x01) ? true : false;
  if (probeMode === 0x01) {
    var kpa = gaugeKpa(rangeSel, idc);
    if (kpa !== null) { data.pressure = { gauge: round(kpa, 3) }; }
  } else if (probeMode === 0x00) {
    // depth mode: (IDC-4mA) * (range*100/16) cm -> extra (not a pressure)
    data.waterDepthCm = idc <= 4.0 ? 0 : round((idc - 4.0) * ((rangeSel * 100) / 16), 3);
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "ps-lb"; }
  return result;
}
