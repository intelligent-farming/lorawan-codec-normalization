// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/ldds20 (LDDS20 LoRaWAN Ultrasonic Liquid
// Level Sensor). A top-mounted non-contact ultrasonic sensor that measures the
// gap from the sensor down to the liquid surface — the tank.distance convention
// (the gap shrinks as the vessel fills).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/ldds20.js, attributed in
// NOTICE). The upstream decoder is buggy and is NOT copied:
//   - it aliases the battery raw word into `data.distance` (assigns the
//     0..1 battery bytes to distance instead of the 2..3 distance bytes), and
//   - it emits string sentinels ('No Sensor' / 'Invalid Reading') in the same
//     numeric field.
// This module reads distance from the correct bytes[2..3] word, always emits a
// numeric tank.distance, and represents no-target / invalid conditions as the
// boolean extras `noTarget` / `invalidReading` (see dingtek/df701 for the same
// pattern).
//
// fPort 2 telemetry (5-byte frame):
//   bytes[0..1] & 0x3fff / 1000       -> battery (V)
//   bytes[2..3]           (mm)        -> tank.distance (m; mm / 1000)
//   bytes[4]                          -> interrupt (extra; interrupt/status byte)
// A frame that is not 5 bytes long means no ultrasonic sensor is attached
// ('No Sensor'): reported as an error. A distance < 20 mm is the device's
// out-of-range / invalid-reading sentinel: surfaced as invalidReading:true while
// still emitting the raw converted distance.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var b = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (!b) {
    return { errors: ['missing payload bytes'] };
  }
  if (b.length !== 5) {
    // Upstream reports this layout as 'No Sensor': no ultrasonic probe attached.
    return { errors: ['no sensor attached (expected 5-byte telemetry frame, got ' + b.length + ')'] };
  }

  var data = {};

  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);

  var distanceMm = (b[2] << 8) | b[3];
  data.tank = { distance: round(distanceMm / 1000, 3) };
  if (distanceMm < 20) {
    // Out-of-range / no valid echo sentinel.
    data.invalidReading = true;
  }

  data.interrupt = b[4];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "ldds20" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "ldds20";
  }
  return result;
}
