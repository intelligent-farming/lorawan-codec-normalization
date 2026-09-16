// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/mds120-lb (MDS120-LB LoRaWAN LiDAR ToF
// Distance / Level Sensor). A top-mounted time-of-flight LiDAR that measures the
// gap from the sensor down to the surface below it — the tank.distance
// convention (the gap shrinks as the vessel fills).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/mds120-lb.js, attributed in
// NOTICE; upstream stores JS with escaped newlines). Upstream emits a flat bag
// (distance in mm with a string 'Invalid Reading' sentinel, temperature_pro,
// flags); this module always emits a numeric tank.distance, surfaces the invalid
// sentinel as the boolean extra `invalidReading`, and keeps the rest as
// camelCase extras. The upstream normalization is never copied.
//
// fPort 2 telemetry (8-byte frame):
//   bytes[0..1] & 0x3fff / 1000       -> battery (V)
//   bytes[2..3]           (mm)        -> tank.distance (m; mm / 1000); 0x3fff == invalid
//   bytes[4] bit0                     -> interruptFlag (extra)
//   bytes[5..6] signed16  / 10        -> temperature (deg C; external DS18B20 probe)
//   bytes[7] bit0                     -> sensorFlag (extra)
//
// fPort 3 (datalog/history) and fPort 4/5 (config / device info) carry no single
// normalized measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  return v & 0x8000 ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var b = input.bytes;

  if (input.fPort === 3) {
    return { errors: ['datalog/history frame (fPort 3) carries no single normalized measurement'] };
  }
  if (input.fPort === 4 || input.fPort === 5) {
    return { errors: ['config / device information frame (fPort ' + input.fPort + '), not a measurement'] };
  }
  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (!b || b.length < 8) {
    return { errors: ['payload too short (need >= 8 bytes)'] };
  }

  var data = {};

  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);

  var distanceMm = (b[2] << 8) | b[3];
  data.tank = { distance: round(distanceMm / 1000, 3) };
  if (distanceMm === 0x3fff) {
    data.invalidReading = true;
  }

  data.interruptFlag = Boolean(b[4] & 0x01);
  data.temperature = round(s16(b[5], b[6]) / 10, 2);
  data.sensorFlag = Boolean(b[7] & 0x01);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "mds120-lb" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "mds120-lb";
  }
  return result;
}
