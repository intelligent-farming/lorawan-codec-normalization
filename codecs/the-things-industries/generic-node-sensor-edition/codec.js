// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for The Things Industries Generic Node (Sensor
// Edition).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/the-things-industries/generic-node-sensor-edition-codec.js, attributed
// in NOTICE). Ported from that decoder's decodeUplink; the normalization is
// authored here and not copied from upstream normalizeUplink.
//
// Upstream decodeUplink (source of truth) reads a fixed 6-byte uplink:
//   bytes[0]              battery voltage, deci-volts  -> battery (V)
//   bytes[1..2] (BE u16)  (raw - 500), deci-degrees    -> air.temperature (°C)
//   bytes[3..4] (BE u16)  raw, deci-percent            -> air.relativeHumidity
//   bytes[5]              button state                 -> button (extra)
//
// The wire payload carries NO light/illuminance and NO PIR/motion field, so
// despite the product's broader sensor suite this codec normalizes only the
// climate channels the upstream decoder actually produces. Battery is reported
// in volts (not a percentage), so it maps directly to the `battery` vocabulary
// key. The `button` field has no vocabulary key and is emitted as a camelCase
// extra.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 6) {
    return { errors: ['expected at least 6 bytes'] };
  }

  var battery = round(bytes[0] / 10, 1);
  var temperature = round(((bytes[1] << 8) + bytes[2] - 500) / 10, 1);
  var relativeHumidity = round(((bytes[3] << 8) + bytes[4]) / 10, 1);
  var button = bytes[5];

  var data = {
    air: {
      temperature: temperature,
      relativeHumidity: relativeHumidity
    },
    battery: battery,
    button: button
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "the-things-industries";
    result.data.model = "generic-node-sensor-edition";
  }
  return result;
}
