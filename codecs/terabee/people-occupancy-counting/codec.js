// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Terabee People Occupancy Counting sensor: an
// overhead time-of-flight sensor that reports how many people are currently
// present in a global counting area and in up to eight configurable sub-zones.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/terabee/people-occupancy-counting.js,
// attributed in NOTICE). This module re-authors the JSON to the normalized
// vocabulary and never copies the upstream output.
//
// Only the counting-data uplink on FPort 83 is a measurement. All other FPorts
// carry command/parameter responses (zone coordinates, versions, height, etc.)
// and are reported as errors.
//
// Field mapping (FPort 83, 10-byte frame):
//   flags byte[0]: bit0 STOPPED, bit1 STUCK, bit2 WIFI_ACCESS_POINT_ON, bit3 WARMUP
//     -> stopped / stuck / wifiAccessPointOn / warmup (boolean extras)
//   zone_global (byte[1])           -> people.present (people currently present)
//   zone_0..zone_7 (bytes[2..9])    -> zone0..zone7 (per-zone occupancy extras;
//                                      the 255 "not set" sentinel becomes null)
//
// people.present semantics: this device reports current occupancy, not entry /
// exit flow, so the global occupancy maps to people.present.

function zoneOccupancy(byte) {
  return byte === 255 ? null : byte;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 83) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 83 counting-data uplink)'] };
  }
  if (!bytes || bytes.length < 10) {
    return { errors: ['counting-data frame too short (expected 10 bytes)'] };
  }

  var flags = bytes[0];
  var data = {};
  data.people = { present: bytes[1] };
  data.stopped = Boolean(flags & 0x01);
  data.stuck = Boolean(flags & 0x02);
  data.wifiAccessPointOn = Boolean(flags & 0x04);
  data.warmup = Boolean(flags & 0x08);
  data.zone0 = zoneOccupancy(bytes[2]);
  data.zone1 = zoneOccupancy(bytes[3]);
  data.zone2 = zoneOccupancy(bytes[4]);
  data.zone3 = zoneOccupancy(bytes[5]);
  data.zone4 = zoneOccupancy(bytes[6]);
  data.zone5 = zoneOccupancy(bytes[7]);
  data.zone6 = zoneOccupancy(bytes[8]);
  data.zone7 = zoneOccupancy(bytes[9]);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "terabee", model: "people-occupancy-counting" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "terabee";
    result.data.model = "people-occupancy-counting";
  }
  return result;
}
