// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for senzemo/ssm40 (Senzemo Senstick SSM40 soil
// moisture sensor). Authored from the upstream Apache-2.0 Senzemo SSM40 decoder
// (attributed in NOTICE).
//
// fPort 2 data packet (4 bytes: battery+sensor voltages; or 5 bytes: status +
// the two voltages). Battery voltage mV -> battery (V, /1000); sensor voltage
// mV is converted to volumetric water content via the manufacturer's cubic
// (VWC) -> soil.moisture (%); the linear voltage-range percentage and raw
// sensor voltage are surfaced as extras. fPort 1 alarm, fPort 3 config and
// fPort 4 firmware-warning frames carry no soil reading and return an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

function voltageToMoisture(mV) {
  var sm = Math.round((mV - 44) * 100 / (2876 - 44));
  if (sm > 100) { sm = 100; } else if (sm < 0) { sm = 0; }
  return sm;
}
function voltageToVwc(mV) {
  var v = mV / 1000;
  var vwc = Math.round((2.8432 * v * v * v) - (9.1993 * v * v) + (20.2553 * v) - 4.1882);
  if (vwc < 0) { vwc = 0; }
  return vwc;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 2) { return { errors: ['fPort ' + input.fPort + ' is not a soil data packet (expected 2)'] }; }
  var status, sensorMv, data = {};
  if (b.length === 4) {
    data.battery = round((((b[0] << 8) | b[1])) / 1000, 3);
    sensorMv = ((b[2] & 0xff) << 8) | b[3];
  } else if (b.length === 5) {
    status = b[0];
    data.battery = round((((b[1] << 8) | b[2])) / 1000, 3);
    sensorMv = ((b[3] & 0xff) << 8) | b[4];
  } else {
    return { errors: ['unexpected data-packet length ' + b.length + ' (expected 4 or 5)'] };
  }
  data.soil = { moisture: voltageToVwc(sensorMv) };
  data.soilMoisturePercent = voltageToMoisture(sensorMv);
  data.sensorVoltage = sensorMv;
  if (status !== undefined) { data.status = status; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "senzemo"; result.data.model = "ssm40"; }
  return result;
}
