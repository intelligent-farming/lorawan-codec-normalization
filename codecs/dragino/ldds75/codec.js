// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/ldds75 (LDDS75 Ultrasonic Distance Sensor). Authored from
// the upstream Apache-2.0 Dragino decoder (TheThingsNetwork/lorawan-devices
// vendor/dragino/ldds75.js, attributed in NOTICE; upstream stores JS with
// escaped newlines), cross-checked against the upstream as oracle.
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; distance b2..3 (mm) -> tank.distance (m).
// Values < 20 mm are invalid -> error. NOTE: the upstream decoder has a bug —
// it assigns the distance from its battery variable instead of bytes[2..3]; this
// codec reads the intended distance bytes, so it does not reproduce that bug. Top-mounted ranging sensor -> tank.distance (m),
// not water.level. fPort 5 device-info -> error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 8) { return { errors: ['payload too short (need >= 8 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  var mm = u16(b[2], b[3]);
  if (mm < 20) { return { errors: ['invalid/no-sensor reading (' + mm + ' mm)'] }; }
  data.tank = { distance: round(mm / 1000, 3) };
  data.distanceMm = mm;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "ldds75"; }
  return result;
}
