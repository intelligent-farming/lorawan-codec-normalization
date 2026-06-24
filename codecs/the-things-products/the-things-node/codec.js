// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for The Things Node (matchbox node based on a
// SparkFun Pro Micro with a Microchip LoRaWAN module: temperature sensor, NXP
// digital accelerometer, light sensor, button, and RGB LED).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/the-things-products/the-things-node.js,
// attributed in NOTICE; see reference/upstream-codec.js). The upstream decode
// is faithful, so the byte layout is reproduced verbatim:
//   fPort           -> event: 1=setup, 2=interval, 3=motion, 4=button
//   bytes[0..1]     -> battery, 16-bit big-endian (millivolts)
//   bytes[2..3]     -> light, 16-bit big-endian (lux)
//   bytes[4..5]     -> temperature, signed 16-bit big-endian, value = raw/100 degC
//
// Normalization notes / vocabulary mapping:
//   * light is a genuine illuminance reading -> air.lightIntensity (lux).
//   * temperature -> air.temperature (degC).
//   * The upstream "battery" field is a raw count; The Things Node firmware
//     reports it in millivolts, so it is converted mV -> V (/ 1000) into the
//     vocabulary `battery` (volts), not pushed in raw.
//   * The fPort-derived event is a status flag the vocabulary does not model;
//     it is kept as the camelCase extra `event`. The "motion" event (fPort 3)
//     is, in addition, surfaced as action.motion.detected so the device
//     satisfies the motion category; the "button" event (fPort 4) is surfaced
//     as the camelCase extra `buttonPressed`.
//
// The Things Node lists "humidity" among its sensors, but the upstream codec
// does NOT decode any humidity channel, so air.relativeHumidity is not emitted
// and the climate category is not claimed.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) + lo) & 0xffff;
}

function s16be(hi, lo) {
  // Sign is carried by the high byte, matching the upstream expression
  // (bytes[4] & 0x80 ? bytes[4] - 0x100 : bytes[4]) shifted left 8 then + lo.
  var h = hi & 0x80 ? hi - 0x100 : hi;
  return (h << 8) + lo;
}

var EVENTS = {
  1: 'setup',
  2: 'interval',
  3: 'motion',
  4: 'button'
};

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 6) {
    return { errors: ['payload too short for a The Things Node uplink (need 6 bytes)'] };
  }

  var event = EVENTS[input.fPort];
  if (event === undefined) {
    return {
      errors: ['unknown fPort ' + input.fPort + ' (expected 1=setup, 2=interval, 3=motion, 4=button)']
    };
  }

  var data = {};
  var air = {};

  air.lightIntensity = u16be(bytes[2], bytes[3]);
  air.temperature = round(s16be(bytes[4], bytes[5]) / 100, 2);
  data.air = air;

  // Upstream battery is a raw 16-bit count reported in millivolts.
  data.battery = round(u16be(bytes[0], bytes[1]) / 1000, 3);

  data.event = event;

  if (input.fPort === 3) {
    data.action = { motion: { detected: true } };
  }
  if (input.fPort === 4) {
    data.buttonPressed = true;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "the-things-products";
    result.data.model = "the-things-node";
  }
  return result;
}
