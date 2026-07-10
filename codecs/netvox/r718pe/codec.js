// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718PE (Wireless Top-Mounted
// Ultrasonic Liquid Level Sensor). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718x.js, shared by
// R718X (device id 0x34) and R718PE (device id 0xB1), attributed in NOTICE).
// Author the normalization here; do NOT copy upstream normalizeUplink.
//
// R718PE is a top-mounted ultrasonic ranging sensor: it measures the gap in the
// air from the sensor down to the surface of the liquid/solid below, which
// decreases as the vessel fills — exactly the tank.distance convention.
//
// fPort 6 frame layout (device id byte[1] == 0xB1 for R718PE):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0xB1 == R718PE)
//   bytes[2]      report type; 0x00 is a device-info frame (SW/HW ver +
//                 datecode) that carries no measurement
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      sensor on/off status (0x00 = OFF, else ON) -> `sensorOn`
//   bytes[5..6]   ranging distance, 16-bit big-endian, in MILLIMETRES
//                 (Netvox R718PE datasheet: the FillMaxDistance /
//                 DeadZoneDistance / OnDistanceThreshold configuration values
//                 are all expressed in mm, and the ~0.25-4.5 m operating range
//                 is reported in mm) -> tank.distance (m; mm / 1000)
//   bytes[7]      device-reported fill level (%) -> tank.level
//   bytes[8..10]  unused for R718PE (Temp / AngleOfInclination exist only on the
//                 R718X variant, device id 0x34)
//
// Config responses (fPort 7) and any other fPort carry no measurement and are
// reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (configuration response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0xB1) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0xB1, R718PE)'] };
  }

  // bytes[2] is the report-type discriminator; 0x00 is a device-info frame.
  if (bytes[2] === 0x00) {
    return { errors: ['device information frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Byte 4: sensor on/off status.
  data.sensorOn = bytes[4] !== 0x00;

  // Bytes 5..6: ranging distance in mm -> tank.distance in metres.
  var distanceMm = (bytes[5] << 8) | bytes[6];
  var tank = {};
  tank.distance = round(distanceMm / 1000, 3);

  // Byte 7: device-reported fill level percentage.
  tank.level = bytes[7];

  data.tank = tank;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718pe";
  }
  return result;
}
