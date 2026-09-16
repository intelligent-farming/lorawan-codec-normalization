// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SouthernIoT SenseClimate (climate sensor:
// ambient temperature + relative humidity).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/southerniot/senseclimate.js,
// attributed in NOTICE). The upstream decodeUplink is the source of truth: on
// fPort 1 it reads bytes[0] as temperature (degrees C, raw integer) and
// bytes[1] as humidity (%RH, raw integer) with no scaling, and rejects every
// other fPort with 'unknown FPort'. This codec reproduces that decode exactly
// and maps the two readings onto the shared vocabulary (air.temperature,
// air.relativeHumidity).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 1) {
    return { errors: ['unknown FPort'] };
  }

  var bytes = input.bytes;
  var air = {};
  air.temperature = round(bytes[0], 1);
  air.relativeHumidity = round(bytes[1], 1);

  return { data: { air: air } };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "southerniot", model: "senseclimate" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "southerniot";
    result.data.model = "senseclimate";
  }
  return result;
}
