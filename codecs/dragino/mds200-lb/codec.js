// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/mds200-lb (MDS200-LB LoRaWAN Dual
// Ultrasonic Distance / Level Sensor). Two top-mounted non-contact ultrasonic
// probes, each measuring the gap from the probe down to the surface below it —
// the tank.distance convention (the gap shrinks as the vessel fills).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/mds200-lb.js, attributed in
// NOTICE; upstream stores JS with escaped newlines). Upstream emits a flat bag
// (distance1/2 in mm, alarm flags); this module maps the primary channel
// (distance1) to tank.distance and keeps the second channel and flags as
// camelCase extras. The upstream normalization is never copied.
//
// fPort 2 telemetry (7-byte frame):
//   bytes[0..1] / 1000                -> battery (V)
//   bytes[2..3]           (mm)        -> tank.distance (m; primary channel 1, mm / 1000)
//   bytes[4..5]           (mm) / 1000 -> distance2Meters (extra; channel 2)
//   bytes[6] bits2..7                 -> distanceAlarmCount (extra)
//   bytes[6] bit1                     -> distanceAlarm (extra)
//   bytes[6] bit0                     -> interruptAlarm (extra)
//
// fPort 3 (datalog/history) and fPort 4/5 (config / device info) carry no single
// normalized measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
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
  if (!b || b.length < 7) {
    return { errors: ['payload too short (need >= 7 bytes)'] };
  }

  var data = {};

  data.battery = round(((b[0] << 8) | b[1]) / 1000, 3);

  var dist1Mm = (b[2] << 8) | b[3];
  data.tank = { distance: round(dist1Mm / 1000, 3) };

  var dist2Mm = (b[4] << 8) | b[5];
  data.distance2Meters = round(dist2Mm / 1000, 3);

  data.distanceAlarmCount = (b[6] >> 2) & 0x3f;
  data.distanceAlarm = Boolean((b[6] >> 1) & 0x01);
  data.interruptAlarm = Boolean(b[6] & 0x01);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "mds200-lb" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "mds200-lb";
  }
  return result;
}
