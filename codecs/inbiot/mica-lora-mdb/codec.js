// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for inBiot MICA-LoRa (Modbus payload variant) —
// an indoor air-quality sensor reporting temperature, humidity, CO2 and a set
// of air-quality indices.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (big-endian uint16 fields keyed off a leading message-type byte)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/inbiot/decoder.js, attributed in
// NOTICE). The normalization below is authored here; the upstream
// InbiotDeviceDecode output shape is NOT copied.
//
// Only the sensor message (message-type byte 0x01) carries measurements; the
// device's configuration (0x00) and information (0x02) frames are not
// measurements and are reported as errors. The MICA family member is read from
// the embedded type string (offsets 27..30); this codec decodes the MICA
// variant's sensor channels (temperature, humidity, CO2, TVOC, PM2.5, PM10)
// plus the device's air-quality indices and noise level as camelCase extras.
//
// The vocabulary models only air.co2 for gas concentration; TVOC / PM / index
// values are emitted as extras. Sentinel readings the device uses for "sensor
// warming up" (0xffff on a uint16 gas/PM channel, or 0xff on the 1-byte noise
// and mould channels) are passed through as the strings "Preheating" /
// "Calculating", matching the device's own semantics.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, hi, lo) {
  return ((bytes[hi] << 8) | bytes[lo]) & 0xffff;
}

function textAt(bytes, start, end) {
  var result = '';
  for (var i = start; i < end; i++) {
    if (bytes[i] === 0x00) {
      break;
    }
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var msgType = bytes[0];
  if (msgType !== 0x01) {
    // 0x00 = configuration frame, 0x02 = device-information frame: neither is a
    // measurement, so there is nothing to normalize.
    return { errors: ['unsupported message type ' + msgType + ' (expected sensor message 1)'] };
  }

  if (bytes.length < 38) {
    return { errors: ['sensor message too short: ' + bytes.length + ' bytes'] };
  }

  var type = textAt(bytes, 27, 31);
  if (type === '') {
    type = 'NULL';
  }
  var micaFamily = { MINI: true, MICA: true, PLUS: true, WELL: true, NULL: true };
  if (!micaFamily[type]) {
    return { errors: ['unrecognized MICA type "' + type + '"'] };
  }

  var data = {};
  var air = {};

  // Climate channels (big-endian uint16, scaled).
  air.temperature = round(u16be(bytes, 1, 2) / 10, 1);
  air.relativeHumidity = round(u16be(bytes, 3, 4) / 10, 1);
  air.co2 = u16be(bytes, 5, 6);
  data.air = air;

  // Air-quality channels present on every family member except MINI.
  if (type !== 'MINI') {
    data.tvoc = u16be(bytes, 9, 10);
    data.pm2_5 = u16be(bytes, 13, 14);
    data.pm10 = u16be(bytes, 17, 18);
  }

  // Device-computed air-quality indices.
  data.ventilationIndex = bytes[32];
  data.thermalIndex = bytes[33];
  data.virusIndex = bytes[34];
  data.iaqIndex = bytes[35];

  var moldIndex = bytes[36];
  data.moldIndex = moldIndex === 0xff ? 'Calculating' : moldIndex;

  // Noise is only reported when non-zero; 0xff marks the sensor warming up.
  if (bytes[37]) {
    data.noise = bytes[37] === 0xff ? 'Preheating' : bytes[37];
  }

  data.counter = u16be(bytes, 25, 26);

  return { data: data };
}
