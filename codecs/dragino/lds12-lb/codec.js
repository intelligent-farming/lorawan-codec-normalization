// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lds12-lb (LDS12-LB LoRaWAN LiDAR ToF
// Distance / Level Sensor). A top-mounted time-of-flight LiDAR that measures the
// gap from the sensor down to the surface below it — the tank.distance
// convention (the gap shrinks as the vessel fills).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lds12-lb.js, attributed in
// NOTICE; upstream stores JS with escaped newlines). Upstream emits a flat bag
// of raw fields (Distance_cm, temperature_pro, lidar_*); this module authors the
// normalized vocabulary keys and keeps the rest as camelCase extras. The
// upstream normalization is never copied.
//
// fPort 2 telemetry (11-byte frame):
//   bytes[0..1] & 0x3fff / 1000       -> battery (V)
//   bytes[2..3] signed16 / 10         -> temperature (deg C; external DS18B20 probe)
//   bytes[4..5] / 10 (cm)             -> tank.distance (m; cm / 100 == raw / 1000)
//   bytes[6..7]                       -> lidarSignal (extra; signal strength)
//   bytes[8] bit0 / bit1              -> interruptFlag / interruptLevelHigh (extras)
//   bytes[9]  signed8                 -> lidarTemp (extra; deg C, sensor internal temp)
//   bytes[10]                         -> messageType (extra)
//
// fPort 3 (datalog/history) and fPort 5 (device information) carry no single
// normalized measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  return v & 0x8000 ? v - 0x10000 : v;
}

function s8(v) {
  v = v & 0xff;
  return v & 0x80 ? v - 0x100 : v;
}

function decodeUplinkCore(input) {
  var b = input.bytes;

  if (input.fPort === 3) {
    return { errors: ['datalog/history frame (fPort 3) carries no single normalized measurement'] };
  }
  if (input.fPort === 5) {
    return { errors: ['device information frame (fPort 5), not a measurement'] };
  }
  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (!b || b.length !== 11) {
    return { errors: ['expected 11-byte telemetry frame, got ' + (b ? b.length : 0)] };
  }

  var data = {};

  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.temperature = round(s16(b[2], b[3]) / 10, 1);

  // LiDAR ranging distance: upstream reports cm (raw / 10); m = cm / 100.
  var distanceCm = ((b[4] << 8) | b[5]) / 10;
  data.tank = { distance: round(distanceCm / 100, 3) };

  data.lidarSignal = ((b[6] << 8) | b[7]);
  data.interruptFlag = Boolean(b[8] & 0x01);
  data.interruptLevelHigh = Boolean(b[8] & 0x02);
  data.lidarTemp = s8(b[9]);
  data.messageType = b[10];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "lds12-lb" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lds12-lb";
  }
  return result;
}
