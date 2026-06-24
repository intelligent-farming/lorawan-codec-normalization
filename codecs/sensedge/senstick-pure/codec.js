// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Sensedge Senstick Pure (Air Quality &
// Microclimate Sensor: IAQ, temperature, humidity, pressure).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed 14-byte big-endian frame on fPort 2) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/sensedge/senstick-pure.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping to the shared vocabulary:
//   Temperature (signed, /100)        -> air.temperature (°C)
//   Humidity (/100)                   -> air.relativeHumidity (%)
//   AirPressure (byte + 845, hPa)     -> air.pressure (hPa)
//   eCO2 (16-bit, ppm)                -> air.co2 (ppm)
// The vocabulary does not model IAQ/VOC/status; those are emitted as camelCase
// extras: status, iaq, staticIaq, breathVoc, iaqAccuracy. The Senstick Pure
// frame carries no battery field, so neither `battery` nor `batteryPercent` is
// produced.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort ' + input.fPort] };
  }

  var bytes = input.bytes;
  if (!bytes || bytes.length < 14) {
    return { errors: ['payload too short: need 14 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var air = {};
  air.temperature = round(s16be(bytes[1], bytes[2]) / 100, 2);
  air.relativeHumidity = round(u16be(bytes[3], bytes[4]) / 100, 2);
  air.pressure = bytes[5] + 845;
  air.co2 = u16be(bytes[10], bytes[11]);

  var data = {
    air: air,
    status: bytes[0],
    iaq: u16be(bytes[6], bytes[7]),
    staticIaq: u16be(bytes[8], bytes[9]),
    breathVoc: round(bytes[12] / 10, 1),
    iaqAccuracy: bytes[13]
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sensedge";
    result.data.model = "senstick-pure";
  }
  return result;
}
