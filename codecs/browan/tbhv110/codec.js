// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Browan TBHV110 (Tabs Healthy Home / IAQ Sensor),
// data uplink on fPort 103.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/tbhv110.js, attributed in
// NOTICE). Air temperature and humidity -> air.temperature /
// air.relativeHumidity; equivalent CO2 (eCO2) -> air.co2. Battery is volts. The
// board temperature, VOC, IAQ index, and the status / tempHumidChanged /
// iaqChanged flags are device-specific camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 103) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 103)'] };
  }

  // An all-zero or empty payload is a non-measurement keep-alive frame upstream
  // returns as {}. The normalized contract forbids a bare {}, so report it.
  var allZero = true;
  var n;
  for (n = 0; n < bytes.length; n++) {
    if (bytes[n] !== 0) {
      allZero = false;
      break;
    }
  }
  if (bytes.length === 0 || allZero) {
    return { errors: ['empty payload'] };
  }

  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var data = {};
  var air = {};

  // Byte 1 low nibble: battery, 2.5 V + 0.1 V steps.
  data.battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);

  // Byte 3 low 7 bits: relative humidity (%).
  air.relativeHumidity = bytes[3] & 0x7f;

  // Byte 10 low 7 bits: air temperature, -32 C offset.
  air.temperature = (bytes[10] & 0x7f) - 32;

  // Bytes 4-5 LE: equivalent CO2 (ppm).
  air.co2 = u16le(bytes[4], bytes[5]);

  data.air = air;

  // Byte 2 low 7 bits: board temperature, -32 C offset (device-specific extra).
  data.boardTemperature = (bytes[2] & 0x7f) - 32;

  // Bytes 6-7 LE: VOC; bytes 8-9 LE: IAQ index (device-specific extras).
  data.voc = u16le(bytes[6], bytes[7]);
  data.iaq = u16le(bytes[8], bytes[9]);

  // Byte 0: status flags (device-specific extras).
  data.status = bytes[0] & 0x01;
  data.tempHumidChanged = (bytes[0] >> 4) & 0x01;
  data.iaqChanged = (bytes[0] >> 5) & 0x01;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "browan";
    result.data.model = "tbhv110";
  }
  return result;
}
