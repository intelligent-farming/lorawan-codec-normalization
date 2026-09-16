// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the MClimate Multipurpose Button (mc-button): a
// single button with three click gestures (single / double / triple) plus a
// thermistor temperature sensor.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/mc-button.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
//
// Keepalive uplink (bytes[0] == 0x01):
//   bytes[0]         frame marker (0x01 keepalive)
//   bytes[1]         battery voltage: (bytes[1] * 8 + 1600) / 1000 V
//   bytes[2] bit2    thermistor connected when 0 -> extra `thermistorProperlyConnected`
//   bytes[2] bits1:0 temperature high bits
//   bytes[3]         temperature low bits; temperature = raw / 10 (degrees C)
//                    -> extra `sensorTemperature`
//   bytes[4]         button press event: 1=single, 2=double, 3=triple, 0=none
//                    -> action.button.event / action.button.pressed; the raw
//                    value is also kept as extra `pressEvent`
//
// Command/response frames (bytes[0] != 0x01) embed configuration data ahead of
// a trailing keepalive; they are not the primary press telemetry and are
// reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function pressEventName(v) {
  if (v === 1) {
    return 'single';
  }
  if (v === 2) {
    return 'double';
  }
  if (v === 3) {
    return 'triple';
  }
  return null;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 5) {
    return { errors: ['expected at least 5 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[0] !== 0x01) {
    return { errors: ['unsupported frame 0x' + bytes[0].toString(16) + ' (command/response, not a keepalive press report)'] };
  }

  var data = {};

  // Byte 1: battery voltage.
  data.battery = round((bytes[1] * 8 + 1600) / 1000, 1);

  // Byte 2 bit2 + bytes 2-3: thermistor status and temperature.
  data.thermistorProperlyConnected = (bytes[2] & 0x04) === 0;
  var temperatureRaw = ((bytes[2] & 0x03) << 8) | bytes[3];
  data.sensorTemperature = round(temperatureRaw / 10, 1);

  // Byte 4: press gesture.
  var pressEvent = bytes[4];
  data.pressEvent = pressEvent;
  var eventName = pressEventName(pressEvent);
  if (eventName !== null) {
    data.action = { button: { pressed: true, event: eventName } };
  } else {
    data.action = { button: { pressed: false } };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "mclimate", model: "mc-button" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mclimate";
    result.data.model = "mc-button";
  }
  return result;
}
