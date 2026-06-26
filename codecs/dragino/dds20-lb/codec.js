// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/dds20-lb (Dragino DDS20-LB submersible
// liquid-level probe). Authored from the upstream Apache-2.0 Dragino decoder
// (attributed in NOTICE; upstream stores JS with escaped newlines).
//
// fPort 2 measurement: battery ((b0<<8|b1)&0x3FFF)/1000; distance b2..3 in mm
// (height of liquid above the probe) -> water.level (m, /1000); DS18B20 probe
// temperature b5..6 signed/10 -> water.temperature.current; interrupt flag b4
// and sensor flag b7 as extras. fPort 3 datalog history and fPort 5 device-info
// frames carry no live level reading and are reported as errors.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 3) { return { errors: ['datalog history frame (fPort 3), not a live measurement'] }; }
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 8) { return { errors: ['payload too short (need >= 8 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  var distanceMm = ((b[2] & 0xff) << 8) | (b[3] & 0xff);
  data.water = { level: round(distanceMm / 1000, 3), temperature: { current: round(s16(b[5], b[6]) / 10, 2) } };
  data.distanceMm = distanceMm;
  data.interruptFlag = b[4];
  data.sensorFlag = b[7];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "dds20-lb"; }
  return result;
}
