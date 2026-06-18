// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for AtomSenses AS-202 (4-in-1 Car Park Air Quality
// Sensor: temperature, humidity, NO2, CO).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight-style channel/type TLV) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/atomsenses/as-202.js, attributed in NOTICE).
//
// AtomSenses reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. The vocabulary does not model
// NO2 or CO, so those are emitted as the camelCase extras `no2` (ppm) and `co`
// (ppm). Unlike upstream — which returns a bare empty object when no channel is
// recognized — this codec follows the module output contract and returns an
// error in that case.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var data = {};
  var air = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE (°C, signed LE, 0.1 resolution)
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY (%RH, 0.5 resolution)
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0x70) {
      // NO2 (ppm) — not modeled by the vocabulary; camelCase extra
      data.no2 = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x09 && type === 0x73) {
      // CO (ppm, unsigned LE) — not modeled by the vocabulary; camelCase extra
      data.co = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized AtomSenses channels'] };
  }
  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }
  return { data: data };
}
