// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718WAA (Wireless Water Leakage /
// Temperature / Humidity Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718wba.js, the
// shared family decoder that also handles deviceType 0xBE = R718WAA;
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports. bytes[0] is the protocol version,
// bytes[1] the device type (0xBE = R718WAA), bytes[2] the report-type
// discriminator. Report type 0x00 is the device-info / startup frame and
// carries no measurement. The status report carries: battery (bytes[3], volts
// at 0.1 V resolution, high bit flags low battery -> surfaced as the camelCase
// extra `lowBattery`), temperature (bytes[4..5], 16-bit BE two's-complement,
// 0.01 C -> air.temperature), humidity (bytes[6..7], 16-bit BE, 0.01 % ->
// air.relativeHumidity), and the water-leak/wet probe state (bytes[8], non-zero
// = leak detected -> water.leak boolean). Config responses (fPort 7) carry no
// measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 9) {
    return { errors: ['expected at least 9 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4-5: temperature, 16-bit BE two's-complement, 0.01 C.
  var rawTemp = (bytes[4] << 8) | bytes[5];
  if (rawTemp & 0x8000) {
    rawTemp = rawTemp - 0x10000;
  }

  // Bytes 6-7: relative humidity, 16-bit BE, 0.01 %.
  var rawHumi = (bytes[6] << 8) | bytes[7];

  data.air = {
    temperature: round(rawTemp / 100, 2),
    relativeHumidity: round(rawHumi / 100, 2)
  };

  // Byte 8: water-leak/wet probe state, non-zero = leak detected.
  data.water = { leak: bytes[8] ? true : false };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718waa";
  }
  return result;
}
