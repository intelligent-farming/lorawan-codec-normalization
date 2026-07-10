// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs AgroSense Soil Moisture Sensor.
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/soil-moisture.js,
// attributed in NOTICE). Upstream extracts exactly two fields:
//   bat = bytes[4] / 10.0                    (battery voltage, V)
//   adc = bytes[2] * 256 + bytes[3]          (raw 12-bit capacitive ADC count)
//
// Mapping into the normalized vocabulary:
//   bat -> battery            (V; ported verbatim, bytes[4] / 10)
//   adc -> soilMoistureAdc    (raw 12-bit capacitive ADC count, camelCase extra)
//
// IMPORTANT: the device measures soil moisture capacitively with a 12-bit ADC,
// but neither the upstream decoder nor the datasheet supplies a calibration
// curve from the raw ADC count to a moisture percentage (the raw count depends
// on soil type, probe insertion depth, and per-unit air/water reference points).
// Emitting a fabricated `soil.moisture` (%) would be wrong, so this codec exposes
// the raw ADC as an extra and emits a warning. Category membership is satisfied
// via `battery`, which soil-monitor lists in its atLeastOne set.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (bytes.length < 5) {
    return { errors: ['payload too short (expected at least 5 bytes)'] };
  }

  var data = {};
  data.battery = round(bytes[4] / 10, 1);
  data.soilMoistureAdc = (bytes[2] * 256) + bytes[3];

  return {
    data: data,
    warnings: [
      'soil moisture reported as an uncalibrated raw capacitive ADC count ' +
        '(soilMoistureAdc); no ADC-to-percent calibration is defined upstream'
    ]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "soil-moisture";
  }
  return result;
}
