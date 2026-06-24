// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MClimate CO2 Display (CO2, temperature,
// humidity, light, PIR display node).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MClimate fixed 11-byte keepalive layout, keyed by the leading
// packet-type byte) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/mclimate/co2-display.js,
// attributed in NOTICE).
//
// MClimate reports battery as a VOLTAGE (raw / 1000 V), so it maps directly to
// the vocabulary `battery` key. The device's own `sensorTemperature` maps to
// air.temperature. PIR occupancy maps to action.motion.detected; the CO2
// power-source status flag has no vocabulary key and is emitted as the
// camelCase extra `powerSourceStatus`.
//
// Note: the upstream decoder builds multi-byte values by string-concatenating
// `byte.toString(16)` without per-byte zero padding, which silently corrupts
// any reading whose low byte is < 0x10. This codec uses correct byte math.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeKeepalive(bytes, data) {
  // bytes[1..2]: temperature, big-endian; (raw - 400) / 10 -> degrees C
  var tempRaw = (bytes[1] << 8) | bytes[2];
  data.air.temperature = round((tempRaw - 400) / 10, 2);

  // bytes[3]: humidity; raw * 100 / 256 -> percent
  data.air.relativeHumidity = round((bytes[3] * 100) / 256, 2);

  // bytes[4..5]: battery voltage in millivolts, big-endian -> volts
  var battRaw = (bytes[4] << 8) | bytes[5];
  data.battery = round(battRaw / 1000, 3);

  // CO2 ppm is a 13-bit value: high 5 bits live in the top of bytes[7],
  // low 8 bits in bytes[6]. powerSourceStatus is the low 3 bits of bytes[7].
  var co2High = (bytes[7] >> 3) & 0x1f;
  data.air.co2 = (co2High << 8) | bytes[6];
  data.powerSourceStatus = bytes[7] & 0x07;

  // bytes[8..9]: illuminance in lux, big-endian
  data.air.lightIntensity = (bytes[8] << 8) | bytes[9];

  // bytes[10]: PIR occupancy flag
  data.action = { motion: { detected: bytes[10] === 1 } };

  return data;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Only the keepalive/periodic uplink (leading byte 0x01) carries
  // measurements. Configuration-response frames append an 11-byte keepalive
  // tail, but their command section is not modeled here.
  if (bytes[0] !== 1) {
    return { errors: ['unsupported packet type: only keepalive (0x01) is decoded'] };
  }

  if (bytes.length < 11) {
    return { errors: ['keepalive payload too short: expected 11 bytes'] };
  }

  var data = { air: {} };
  decodeKeepalive(bytes, data);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mclimate";
    result.data.model = "co2-display";
  }
  return result;
}
