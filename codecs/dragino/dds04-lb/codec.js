// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/dds04-lb (DDS04-LB LoRaWAN 4-Channel
// Ultrasonic Distance Sensor). Up to four top-mounted non-contact ultrasonic
// probes, each measuring the gap from the probe down to the surface below it —
// the tank.distance convention (the gap shrinks as the vessel fills).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/DDS04-LB.js, attributed in
// NOTICE; upstream stores JS with escaped newlines). Upstream emits a flat bag
// of raw fields (distance1..4, exti_*); this module maps the primary channel
// (distance1) to tank.distance and keeps channels 2-4 and the flags as camelCase
// extras. The upstream normalization is never copied.
//
// fPort 2 telemetry (11-byte frame):
//   bytes[0..1] & 0x3fff / 1000       -> battery (V)
//   bytes[0] bit6 / bit7              -> extiTrigger / extiLevelHigh (extras)
//   bytes[2..3] / 10 (cm)             -> tank.distance (m; primary channel 1)
//   bytes[4..5] / 10 (cm) / 100       -> distance2Meters (extra; channel 2)
//   bytes[6..7] / 10 (cm) / 100       -> distance3Meters (extra; channel 3)
//   bytes[8..9] / 10 (cm) / 100       -> distance4Meters (extra; channel 4)
//   bytes[10]                         -> messageType (extra)
//
// fPort 3 (datalog/history) and fPort 5 (device information) carry no single
// normalized measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Channel distance: upstream reports cm (raw / 10); m = cm / 100.
function distMeters(hi, lo) {
  var cm = ((hi << 8) | lo) / 10;
  return round(cm / 100, 3);
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
  data.extiTrigger = Boolean(b[0] & 0x40);
  data.extiLevelHigh = Boolean(b[0] & 0x80);

  data.tank = { distance: distMeters(b[2], b[3]) };
  data.distance2Meters = distMeters(b[4], b[5]);
  data.distance3Meters = distMeters(b[6], b[7]);
  data.distance4Meters = distMeters(b[8], b[9]);
  data.messageType = b[10];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "dds04-lb";
  }
  return result;
}
