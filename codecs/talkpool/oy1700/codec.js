// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TalkPool OY1700 (LoRaWAN Particles meter:
// temperature, humidity, and particulate matter PM1.0 / PM2.5 / PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/talkpool/oy1700.js, attributed in
// NOTICE). Ported faithfully from that decoder's DecodeOy1700Payload.
//
// Wire format (fPort 2, 9 bytes), reconstructed from upstream's hex-string
// indexing into bit fields:
//   - temperature: 12-bit big-endian = (bytes[0] << 4) | (bytes[2] >> 4),
//     scaled value / 10 - 80 (°C).
//   - humidity:    12-bit big-endian = (bytes[1] << 4) | (bytes[2] & 0x0f),
//     scaled value / 10 - 25 (%).
//   - PM1.0:  16-bit big-endian bytes[3..4] (µg/m³).
//   - PM2.5:  16-bit big-endian bytes[5..6] (µg/m³).
//   - PM10:   16-bit big-endian bytes[7..8] (µg/m³).
//
// Mapping to the normalized vocabulary: temperature -> air.temperature;
// humidity -> air.relativeHumidity. The vocabulary does not model particulate
// matter, so PM readings are emitted as camelCase extras (pm1_0, pm2_5, pm10)
// nested under `air`, per the air-quality category guidance.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length !== 9) {
    return { errors: ['expected 9 bytes on fPort 2, got ' + bytes.length] };
  }

  // 12-bit packed temperature and humidity. byte[2] holds the low nibble of
  // each value (temperature high nibble, humidity low nibble).
  var tempRaw = (bytes[0] << 4) | (bytes[2] >> 4);
  var humRaw = (bytes[1] << 4) | (bytes[2] & 0x0f);

  var air = {};
  air.temperature = round(tempRaw / 10 - 80, 1);
  air.relativeHumidity = round(humRaw / 10 - 25, 1);
  air.pm1_0 = u16be(bytes[3], bytes[4]);
  air.pm2_5 = u16be(bytes[5], bytes[6]);
  air.pm10 = u16be(bytes[7], bytes[8]);

  return { data: { air: air } };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "talkpool";
    result.data.model = "oy1700";
  }
  return result;
}
