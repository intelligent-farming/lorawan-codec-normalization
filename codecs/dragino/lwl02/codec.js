// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LWL02 (Water Leak / Door Sensor),
// real-time status uplink (fPort 10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lwl02.js, attributed in
// NOTICE). The LWL02 is a dual-purpose probe with a work-mode byte (MOD):
// MOD 1 reports door open/close, MOD 2 reports water leak, MOD 3 reports both.
// The water-leak state lives in a fixed status bit and is emitted as the
// vocabulary `water.leak` in every mode; door, counter, duration and alarm
// fields are device-specific camelCase extras. Counter/duration extras are
// only emitted in the mode that populates them.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return { errors: ['unknown FPort ' + input.fPort + ' (expected 10)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
  }

  var batteryRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff; // mV
  var mod = bytes[2];

  var data = {};
  data.battery = round(batteryRaw / 1000, 3);
  data.water = { leak: (bytes[0] & 0x40) === 0x40 };
  data.mod = mod;

  if (mod === 1) {
    // Door work mode.
    data.doorOpen = (bytes[0] & 0x80) === 0x80;
    data.doorOpenEvents = (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
    data.lastDoorOpenDuration = (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]; // minutes
    data.alarm = (bytes[9] & 0x01) === 0x01;
  } else if (mod === 2) {
    // Water-leak work mode.
    data.leakEvents = (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
    data.lastLeakDuration = (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]; // minutes
  } else if (mod === 3) {
    // Combined door + leak mode.
    data.doorOpen = (bytes[0] & 0x80) === 0x80;
    data.alarm = (bytes[9] & 0x01) === 0x01;
  } else {
    return { errors: ['unknown work mode (MOD) ' + mod] };
  }

  return { data: data };
}
