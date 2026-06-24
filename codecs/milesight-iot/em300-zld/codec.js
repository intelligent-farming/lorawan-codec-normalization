// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM300-ZLD (Zone Leak Detection
// Sensor: liquid/zone leak via long impedance cable + temperature + humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em300-zld.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Ported from the upstream decodeUplink/Decoder. Channel map:
//   0x01/0x75 battery     byte %                   -> batteryPercent extra
//   0x03/0x67 temperature int16 LE /10 °C          -> air.temperature
//   0x04/0x68 humidity    byte /2 %                -> air.relativeHumidity
//   0x05/0x00 water leak  byte (0=normal,else leak)-> water.leak (boolean)
//
// Divergences from upstream:
//   - Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
//     volts, so the percentage is emitted as the camelCase extra
//     `batteryPercent` rather than being forced into a volts field.
//   - Upstream emits the leak state as the string 'normal'/'leak'; the
//     vocabulary models leak as the boolean `water.leak`, so we emit a boolean
//     (true = leak detected).

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;
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
      // TEMPERATURE: int16 LE, 0.1 °C resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 % resolution
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // WATER LEAK: status byte (0 = normal, else leak)
      data.water = { leak: bytes[i + 2] !== 0 };
      i += 3;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "em300-zld";
  }
  return result;
}
