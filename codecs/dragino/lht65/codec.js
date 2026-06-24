// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LHT65 (Temperature & Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lht65.js, attributed in
// NOTICE). The upstream normalizeUplink emits a two-element array (built-in SHT
// reading + external probe reading); this module's single-measurement shape
// keeps the built-in SHT sensor as `air` and exposes the external DS18B20 probe
// as the camelCase extra `externalTemperature`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16(hi, lo) {
  var v = (hi << 8) | lo;
  return v & 0x8000 ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var ext = bytes[6] & 0x0f;
  var data = {};
  var air = {};

  // Bytes 0-1: battery voltage, low 14 bits, mV -> V (layout differs when the
  // external-sensor field signals a DS18B20+timestamp frame, ext == 0x09).
  if (ext !== 0x09) {
    var battRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
    data.battery = round(battRaw / 1000, 3);
  }

  // Bytes 2-5: built-in SHT temperature/humidity (absent when ext == 0x0f).
  if (ext !== 0x0f) {
    air.location = 'indoor';
    air.temperature = round(s16(bytes[2], bytes[3]) / 100, 2);
    air.relativeHumidity = round((((bytes[4] << 8) | bytes[5]) & 0xfff) / 10, 1);
  }

  // Bytes 7-8: external-sensor payload, interpreted by the ext nibble.
  if (ext === 1) {
    data.externalTemperature = round(s16(bytes[7], bytes[8]) / 100, 2);
  } else if (ext === 5) {
    air.lightIntensity = (bytes[7] << 8) | bytes[8];
  }

  if (air.temperature !== undefined || air.lightIntensity !== undefined) {
    data.air = air;
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lht65";
  }
  return result;
}
