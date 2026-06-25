// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LHT52 (indoor Temperature & Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lht52.js, attributed in
// NOTICE). The upstream normalizeUplink emits a two-element array (built-in SHT
// reading + external DS18B20 probe reading); this module's single-measurement
// shape keeps the built-in SHT sensor as `air` (indoor) and exposes the external
// DS18B20 probe as the camelCase extra `externalTemperature`.
//
// fPort 2 carries the temperature/humidity uplink (11 bytes). fPort 5 carries a
// device-status report (firmware/band/battery); its battery is mapped to the
// vocabulary `battery` key. fPort 3/4 are vendor frames with no calibrated
// vocabulary value and are reported as warnings.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16(hi, lo) {
  var v = ((hi << 8) | lo) & 0xffff;
  return v & 0x8000 ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port === 2) {
    if (bytes.length !== 11) {
      // Short/long frame: device reports RPL data or a sensor reset, not a reading.
      return {
        data: { status: 'RPL data or sensor reset' },
        warnings: ['fPort 2 payload is not an 11-byte reading; no measurement decoded']
      };
    }

    var data = {};
    var air = { location: 'indoor' };

    // Bytes 0-1: built-in SHT temperature, signed 16-bit, /100 -> degC.
    air.temperature = round(s16(bytes[0], bytes[1]) / 100, 2);
    // Bytes 2-3: built-in SHT relative humidity, signed 16-bit, /10 -> %.
    air.relativeHumidity = round(s16(bytes[2], bytes[3]) / 10, 1);
    data.air = air;

    // Bytes 4-5: external DS18B20 probe temperature, signed 16-bit, /100 -> degC.
    data.externalTemperature = round(s16(bytes[4], bytes[5]) / 100, 2);
    // Byte 6: external-sensor connection/extension flag.
    data.ext = bytes[6];
    // Bytes 7-10: device-side unix timestamp (seconds).
    data.systimestamp = ((bytes[7] << 24) | (bytes[8] << 16) | (bytes[9] << 8) | bytes[10]) >>> 0;

    return { data: data };
  }

  if (port === 5) {
    if (bytes.length !== 7) {
      return { errors: ['expected 7 bytes on fPort 5, got ' + bytes.length] };
    }
    var status = {};
    status.sensorModel = bytes[0];
    status.firmwareVersion = ((bytes[1] << 8) | bytes[2]).toString(16);
    status.freqBand = bytes[3];
    status.subBand = bytes[4];
    // Bytes 5-6: battery, mV -> V.
    status.battery = round(((bytes[5] << 8) | bytes[6]) / 1000, 3);
    return { data: status };
  }

  if (port === 3 || port === 4) {
    return {
      errors: ['fPort ' + port + ' carries vendor data with no calibrated measurement']
    };
  }

  return { errors: ['unsupported fPort ' + port] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lht52";
  }
  return result;
}
