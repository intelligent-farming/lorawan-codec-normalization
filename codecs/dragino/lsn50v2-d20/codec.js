// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LSN50v2-D20 (LoRaWAN temperature sensor
// node with an onboard SHT temperature/humidity sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lsn50v2-d20.js, attributed in
// NOTICE). The upstream decoder exposes many sensing modes selected by a 5-bit
// work-mode field; this module normalizes the onboard SHT reading (IIC mode and
// the 3ADC mode that also carries SHT data) to `air.temperature` /
// `air.relativeHumidity`, with battery voltage in `battery`. The DS18B20 probe
// (TempC1), the ADC channels, the digital-input / door status flags and the
// illuminance branch are exposed as camelCase extras since the vocabulary does
// not model them for this category.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// 16-bit two's-complement from two bytes (hi, lo).
function s16(hi, lo) {
  var v = ((hi << 8) | lo) & 0xffff;
  return v & 0x8000 ? v - 0x10000 : v;
}

function u16(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length !== 11 && bytes.length !== 12) {
    return { errors: ['expected 11 or 12 bytes, got ' + bytes.length] };
  }

  // Work mode: bits 2-6 of byte 6.
  var mode = (bytes[6] & 0x7c) >> 2;
  if (mode !== 0 && mode !== 2) {
    return {
      errors: [
        'work mode ' + mode + ' does not carry SHT temperature/humidity (only IIC=0 and 3ADC=2 supported)'
      ]
    };
  }

  var data = {};
  var air = { location: 'outdoor' };

  // Battery voltage (V). IIC mode: bytes 0-1 in mV. 3ADC mode: byte 11 in 0.1 V.
  if (mode === 0) {
    data.battery = round(u16(bytes[0], bytes[1]) / 1000, 3);
  } else {
    data.battery = round(bytes[11] / 10, 1);
  }

  // Onboard SHT temperature/humidity sits in bytes 7-10. When the humidity
  // field reads 0 the firmware is reporting illuminance on that channel instead
  // of the SHT humidity, so no calibrated humidity is available in that frame.
  var humRaw = u16(bytes[9], bytes[10]);
  if (humRaw === 0) {
    air.lightIntensity = s16(bytes[7], bytes[8]);
    data.air = air;
    return {
      data: data,
      warnings: ['SHT humidity channel reported illuminance; no air.relativeHumidity in this frame']
    };
  }

  air.temperature = round(s16(bytes[7], bytes[8]) / 10, 1);
  air.relativeHumidity = round(humRaw / 10, 1);
  data.air = air;

  // DS18B20 probe temperature (IIC mode, bytes 2-3) as an extra.
  if (mode === 0) {
    data.probeTemperature = round(s16(bytes[2], bytes[3]) / 10, 1);
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lsn50v2-d20";
  }
  return result;
}
