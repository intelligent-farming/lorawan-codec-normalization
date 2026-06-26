// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/dds45-lb (DDS45-LB Ultrasonic Distance Sensor). Ported from
// the upstream Apache-2.0 Dragino decoder (TheThingsNetwork/lorawan-devices
// vendor/dragino/dds45-lb.js, attributed in NOTICE; upstream stores JS with
// escaped newlines), cross-checked against the upstream as oracle.
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000. distance b2..3 (mm) -> tank.distance (m, /1000); DS18B20 b5..6 signed/10 -> probeTemperature. This is a top-mounted
// ranging sensor — the reported distance is the gap to the target/surface, so it
// maps to tank.distance (tank-level), not water.level (hydrostatic depth). The
// DS18B20 probe temperature is a probeTemperature extra. fPort 5 device-info -> error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 8) { return { errors: ['payload too short (need >= 8 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.tank = { distance: round((((b[2] & 0xff) << 8) | b[3]) / 1000, 3) };
  data.distanceMm = ((b[2] & 0xff) << 8) | b[3];
  data.probeTemperature = round(s16(b[5], b[6]) / 10, 2);
  data.interruptFlag = b[4];
  data.sensorFlag = b[7];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "dds45-lb"; }
  return result;
}
