// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for AtomSenses AS-204 (5-in-1 Smart Toilet Odour
// Sensor: temperature, humidity, CO2, NH3, H2S).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (AtomSenses channel/type TLV, Milesight-style) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/atomsenses/as-204.js, attributed in NOTICE). The normalization here is
// authored, not copied: upstream returns a bare `{}` when no channel is
// recognized; this codec reports that as an error instead.
//
// AtomSenses reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. NH3 and H2S are not modelled by
// the vocabulary, so they are emitted as the camelCase extras `nh3` and `h2s`
// (ppm).

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
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      i += 3;
      recognized = true;
    } else if (channel === 0x07 && type === 0x7d) {
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x7d) {
      data.nh3 = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x09 && type === 0x7d) {
      data.h2s = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized AtomSenses channels'] };
  }
  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.co2 !== undefined
  ) {
    data.air = air;
  }
  return { data: data };
}
