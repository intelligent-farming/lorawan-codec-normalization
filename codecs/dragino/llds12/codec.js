// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/llds12 (LLDS12 LiDAR ToF Distance Sensor). Authored from
// the upstream Apache-2.0 Dragino decoder (TheThingsNetwork/lorawan-devices
// vendor/dragino/llds12.js, attributed in NOTICE; upstream stores JS with
// escaped newlines), cross-checked against the upstream as oracle.
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; DS18B20 b2..3 signed/10 -> probeTemperature; Lidar distance (b4..5)/10 cm -> tank.distance (m); signal/flags as extras. Top-mounted ranging sensor -> tank.distance (m),
// not water.level. fPort 5 device-info -> error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 11) { return { errors: ['payload too short (need >= 11 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.probeTemperature = round(s16(b[2], b[3]) / 10, 2);
  data.tank = { distance: round((u16(b[4], b[5]) / 10) / 100, 3) };
  data.lidarSignal = u16(b[6], b[7]);
  data.interruptFlag = b[8];
  data.messageType = b[10];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "llds12" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "llds12"; }
  return result;
}
