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
//   bat -> battery      (V; ported verbatim, bytes[4] / 10)
//   adc -> analog.raw   (raw 12-bit capacitive ADC count)
//
// IMPORTANT: the device measures soil moisture capacitively with a 12-bit ADC,
// but neither the upstream decoder nor the datasheet supplies a calibration
// curve from the raw ADC count to a moisture percentage (the raw count depends
// on soil type, probe insertion depth, and per-unit air/water reference points).
// Emitting a fabricated `soil.moisture` (%) would be wrong, so this codec
// publishes the uncalibrated count and warns about it.
//
// The count goes to `analog.raw` — "Raw analog-to-digital converter count", the
// vocabulary key for exactly this — rather than to a `soilMoistureAdc` extra as
// it once did. An extra would have made this device's only reading invisible to
// every consumer that works from the vocabulary, and would have minted a second
// metric name for a quantity the vocabulary already has a home for. Hence the
// two declared categories: `analog-interface` (atLeastOne includes analog.raw)
// is where the reading actually lives, while `soil-monitor` still holds because
// this is a soil probe and that category's atLeastOne set lists `battery` — it
// contributes no `soil.*` value, by design, until a calibration exists.

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
  data.analog = { raw: (bytes[2] * 256) + bytes[3] };

  return {
    data: data,
    warnings: [
      'soil moisture reported as an uncalibrated raw capacitive ADC count ' +
        '(analog.raw); no ADC-to-percent calibration is defined upstream'
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
