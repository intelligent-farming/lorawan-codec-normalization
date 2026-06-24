// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Sensedge SensTick Pro (multi-sensor
// microclimate node: temperature, humidity, air-pressure byte, movement,
// battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/sensedge/senstick-pro.js, attributed
// in NOTICE). Ported faithfully from the upstream fPort-2 fixed-layout decode:
//   byte 0      Status (raw)
//   bytes 1..2  Temperature, signed 16-bit big-endian, /100 -> °C
//   bytes 3..4  Humidity,    unsigned 16-bit big-endian, /100 -> %
//   byte 5      AirPressure  (raw single byte; see note below)
//   byte 6      Movement,    /100
//   byte 7      BatteryLevel (byte + 100) / 100 -> volts
// Any other fPort -> { errors: ['unknown FPort'] }.
//
// Upstream bug note: the upstream decoder references `bytes` without binding
// `var bytes = input.bytes`, so its fPort-2 path throws ReferenceError in a
// sandboxed console; this port binds `bytes` so the documented arithmetic runs.
//
// Mapping notes:
//   * AirPressure is a single byte (0..255) and cannot represent realistic
//     atmospheric pressure, whose vocabulary bound is 900..1100 hPa. Forcing it
//     into `air.pressure` would violate that bound, so the raw value is emitted
//     as the camelCase extra `airPressureRaw` and `air.pressure` is NOT claimed.
//   * Movement is reported as a fractional value; it is normalized to the
//     boolean `action.motion.detected` (detected when the raw value is nonzero).
//   * BatteryLevel already decodes to volts, so it maps to the vocabulary
//     `battery` (V) directly.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16be(hi, lo) {
  var v = ((hi << 8) | lo) & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['fPort 2 payload must be at least 8 bytes'] };
  }

  var air = {};
  air.temperature = round(s16be(bytes[1], bytes[2]) / 100, 2);
  air.relativeHumidity = round(u16be(bytes[3], bytes[4]) / 100, 2);

  var data = {
    status: bytes[0],
    air: air,
    airPressureRaw: bytes[5],
    action: { motion: { detected: bytes[6] !== 0 } },
    battery: round((bytes[7] + 100) / 100, 2)
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sensedge";
    result.data.model = "senstick-pro";
  }
  return result;
}
