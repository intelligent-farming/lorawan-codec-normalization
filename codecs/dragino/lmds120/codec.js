// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lmds120 (LMDS120 LoRaWAN Microwave Radar
// Distance / Level Sensor). A top-mounted microwave-radar ranging sensor that
// measures the gap from the sensor down to the surface below it — the
// tank.distance convention (the gap shrinks as the vessel fills). Radar tolerates
// condensation / dust better than ultrasonic or LiDAR.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/"lmds120 decoder.js",
// attributed in NOTICE). NOTE: the upstream codec.yaml references a file named
// "lmds120.js" that does not exist and carries a stale example (an SHT
// temperature/humidity payload that the real decoder cannot produce); the true
// decoder is "lmds120 decoder.js". Because that example is untrustworthy, the
// test vectors here are synthetic, computed by hand from the real decoder's field
// layout. The upstream normalization is never copied.
//
// fPort 2 telemetry (8-byte frame):
//   bytes[0..1] & 0x3fff / 1000       -> battery (V)
//   bytes[2..3]           (mm)        -> tank.distance (m; mm / 1000); 0x3fff == invalid
//   bytes[4] bit0                     -> interruptFlag (extra)
//   bytes[5..6] signed16  / 10        -> temperature (deg C; external DS18B20 probe)
//   bytes[7] bit0                     -> sensorFlag (extra)
//
// fPort 5 (device information) carries no measurement and is reported as an error.

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

  if (input.fPort === 5) {
    return { errors: ['device information frame (fPort 5), not a measurement'] };
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
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lmds120";
  }
  return result;
}
