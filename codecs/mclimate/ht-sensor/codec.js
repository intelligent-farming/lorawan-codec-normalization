// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MClimate HT Sensor (Humidity & Temperature
// Sensor, with optional external thermistor probe).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/ht-sensor.js, attributed in
// NOTICE). The TTN decoder is the source of truth for the MClimate fixed 7-byte
// keepalive/data-frame layout; the keepalive arithmetic below is ported
// faithfully from it, including the quirky MSB-first binary-string indexing the
// upstream uses for the thermistor-connected flag.
//
// MClimate reports battery as a VOLTAGE (2 V baseline + 0.1 V per step of the
// high nibble of byte[4]), so it maps directly to the vocabulary `battery` key.
// The device's own `sensorTemperature` maps to air.temperature and
// `relativeHumidity` to air.relativeHumidity. The thermistor-connected status
// flag and the external thermistor reading have no vocabulary key and are
// emitted as the camelCase extras `thermistorProperlyConnected` and
// `extThermistorTemperature` (°C, only meaningful when the thermistor is
// connected).
//
// Non-keepalive frames are configuration-response frames: upstream parses a
// variable-length command section and then decodes the trailing 7-byte
// keepalive tail. This codec is a normalized measurement decoder, so it only
// emits the measurement tail; the command section is not modeled.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// hex(byte) -> zero-padded two-char lowercase hex string, matching the upstream
// ("0" + byte.toString(16)).substr(-2) idiom.
function hex2(byte) {
  return ('0' + byte.toString(16)).substr(-2);
}

// decbin(n) reproduces the upstream helper: the minimal-width (NOT zero-padded)
// binary string, MSB first. Upstream reads character index [5] of this string
// for the thermistor-connected flag, so the lack of padding is load-bearing and
// is preserved verbatim.
function decbin(number) {
  if (number < 0) {
    number = 0xffffffff + number + 1;
  }
  return parseInt(number, 10).toString(2);
}

// Decode the 7-byte keepalive tail starting at offset `off` within `bytes`.
function decodeKeepalive(bytes, off, data, air) {
  // bytes[off+1..off+2]: temperature, big-endian; (raw - 400) / 10 -> degrees C
  var tempHex = hex2(bytes[off + 1]) + hex2(bytes[off + 2]);
  var tempDec = parseInt(tempHex, 16);
  air.temperature = round((tempDec - 400) / 10, 2);

  // bytes[off+3]: humidity; raw * 100 / 256 -> percent
  air.relativeHumidity = round((bytes[off + 3] * 100) / 256, 2);

  // bytes[off+4]: battery voltage. High nibble (hex char [0]) steps 0.1 V from a
  // 2 V baseline.
  var batteryTmp = hex2(bytes[off + 4])[0];
  var batteryVoltage = 2 + parseInt('0x' + batteryTmp, 16) * 0.1;
  data.battery = round(batteryVoltage, 2);

  // bytes[off+5]: thermistor-connected flag is character index [5] of the
  // unpadded MSB-first binary string of the byte (== '0' means connected; a
  // shorter string yields undefined, which compares false).
  var thermistorProperlyConnected = decbin(bytes[off + 5])[5] == 0;
  data.thermistorProperlyConnected = thermistorProperlyConnected;

  // External thermistor temperature: low nibble of byte[off+5] (high nibble of
  // the 12-bit value) concatenated with byte[off+6], * 0.1 -> degrees C. Only
  // meaningful when the thermistor is connected; otherwise reported as 0 to
  // match upstream.
  var extT1 = hex2(bytes[off + 5])[1];
  var extT2 = hex2(bytes[off + 6]);
  var extThermistorTemperature = 0;
  if (thermistorProperlyConnected) {
    extThermistorTemperature = parseInt('0x' + extT1 + '' + extT2, 16) * 0.1;
  }
  data.extThermistorTemperature = round(extThermistorTemperature, 2);

  return data;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Keepalive/data frame: leading byte 0x01, 7 bytes total.
  // Anything else is a configuration-response frame whose command section is
  // followed by a trailing 7-byte keepalive; we decode only that tail.
  var off;
  if (bytes[0] == 1) {
    off = 0;
  } else {
    off = bytes.length - 7;
  }

  if (off < 0 || bytes.length < off + 7) {
    return { errors: ['payload too short: expected at least a 7-byte keepalive frame'] };
  }

  var data = {};
  var air = {};
  decodeKeepalive(bytes, off, data, air);
  data.air = air;
  return { data: data };
}
