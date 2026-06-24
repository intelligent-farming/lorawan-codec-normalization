// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LSPH01 (Soil pH & Soil Temperature
// Sensor).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lsph01.js, attributed in
// NOTICE). The fPort 2 decode below is ported faithfully from that upstream
// decoder; only the output keys are normalized to this module's vocabulary and
// the values are emitted as numbers (upstream emits fixed-point strings).
//
// Wire layout (fPort 2), ported faithfully from the upstream decoder:
//   bytes[0..1]  battery, low 14 bits, millivolts            -> battery (V, /1000)
//   bytes[2..3]  DS18B20 external probe temp, signed, 0.1 C  -> externalTemperature (extra)
//   bytes[4..5]  soil pH, 0.01 resolution                    -> soil.pH (/100)
//   bytes[6..7]  soil temperature, signed, 0.1 C             -> soil.temperature (/10)
//   bytes[8]     interrupt flag                              -> interruptFlag (extra)
//   bytes[10]    message type                                -> messageType (extra)
//
// The DS18B20 channel is an optional external probe, not the in-ground soil
// temperature, so it normalizes to the camelCase extra `externalTemperature`
// rather than `soil.temperature`. Upstream's signed handling is preserved:
// the DS18B20 channel sign-extends via 0xffff0000 (correct two's complement),
// while the soil-temperature channel uses `(value - 0xffff)` for negatives.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unknown FPort ' + input.fPort + ' (expected 2)'] };
  }
  if (!bytes || bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data = {};
  var soil = {};
  var value;

  // bytes[0..1]: battery voltage, low 14 bits, millivolts -> volts.
  var battRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
  data.battery = round(battRaw / 1000, 3);

  // bytes[2..3]: DS18B20 external probe temperature, signed 16-bit, 0.1 C.
  // Upstream sign-extends to 32 bits via 0xffff0000.
  value = (bytes[2] << 8) | bytes[3];
  if (bytes[2] & 0x80) {
    value = value | 0xffff0000;
  }
  data.externalTemperature = round(value / 10, 2);

  // bytes[4..5]: soil pH, 0.01 resolution.
  value = (bytes[4] << 8) | bytes[5];
  soil.pH = round(value / 100, 2);

  // bytes[6..7]: soil temperature, signed 16-bit, 0.1 C. Upstream uses
  // (value - 0xffff) for negatives (off by one count); preserved for fidelity.
  value = (bytes[6] << 8) | bytes[7];
  var temp;
  if (((value & 0x8000) >> 15) === 0) {
    temp = value / 10;
  } else {
    temp = (value - 0xffff) / 10;
  }
  soil.temperature = round(temp, 2);

  // bytes[8]: interrupt flag.
  data.interruptFlag = bytes[8];

  // bytes[10]: message type.
  data.messageType = bytes[10];

  data.soil = soil;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lsph01";
  }
  return result;
}
