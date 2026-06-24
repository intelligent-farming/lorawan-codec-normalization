// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Teneo IoT Soil Moisture Sensor
// (in-ground soil moisture + soil temperature probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/teneo-iot/soil-moisture-sensor.js,
// attributed in NOTICE). Ported from that decoder; do NOT copy upstream
// normalizeUplink as our output.
//
// Wire format (ported faithfully from the upstream decoder):
//   byte 0       : battery, volts = 2 + byte/10           -> battery (V)
//   fPort 1 (measurement):
//     byte 1     : soil moisture, % (no scaling)          -> soil.moisture (%)
//     length 2   : moisture only (no temperature reading)
//     length 6   : moisture + temperature, where
//       bytes 2..3 : soil temperature x100, big-endian, signed via a 16-bit
//                    sign extension on byte 2 (high) and byte 3 (low):
//                    (byte2<<24>>16 | byte3) / 100         -> soil.temperature (C)
//                    (bytes 4..5 are present on the wire but unused upstream)
//     any other length on fPort 1 is malformed (upstream errorcode -1).
//   fPort 3      : charging frame, carries no soil reading.
//   empty payload: no reading.
//
// This device reports battery as VOLTS (2.0-3.5 V), so it maps to the vocabulary
// `battery` (not `batteryPercent`), matching the upstream `2 + byte/10`. Upstream
// always returns {data} with valid/charging/errorcode flags and never errors; for
// the normalized contract, frames that carry no soil measurement (empty payload,
// charging frame, malformed length) return {errors} instead. The upstream
// `sensorType`, `settingsAllowed`, `charging` and `valid` flags are device
// specific and emitted as camelCase extras alongside the soil measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload (no reading)'] };
  }

  // byte 0: battery, volts = 2 + byte/10 (upstream).
  var battery = round(2 + bytes[0] / 10, 2);

  if (input.fPort === 3) {
    // Charging frame: upstream sets charging=true, valid=false, no reading.
    return { errors: ['charging frame on fPort 3 (no reading)'] };
  }

  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort] };
  }

  if (bytes.length !== 2 && bytes.length !== 6) {
    // Upstream sets valid=false, errorcode=-1 for any other length on fPort 1.
    return {
      errors: [
        'malformed fPort 1 frame: expected 2 or 6 bytes, got ' + bytes.length
      ]
    };
  }

  var data = {};
  var soil = {};

  // byte 1: soil moisture, percent (no scaling upstream).
  soil.moisture = bytes[1];

  if (bytes.length === 6) {
    // bytes 2..3: soil temperature x100, 16-bit sign-extended high byte.
    var tempX100 = ((bytes[2] << 24) >> 16) | bytes[3];
    soil.temperature = round(tempX100 / 100, 2);
  }

  data.soil = soil;
  data.battery = battery;

  // Device-specific flags from upstream, emitted as camelCase extras.
  data.sensorType = 'moisture';
  data.settingsAllowed = true;
  data.charging = false;
  data.valid = true;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "teneo-iot";
    result.data.model = "soil-moisture-sensor";
  }
  return result;
}
