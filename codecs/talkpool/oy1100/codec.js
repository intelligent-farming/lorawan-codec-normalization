// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TalkPool OY1100 (LoRaWAN temperature and
// humidity sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (12-bit packed temperature + humidity) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/talkpool/oy1100.js, attributed in NOTICE).
//
// Ported from upstream DecodeOy1100Payload: each reading is a 12-bit value.
// Temperature uses byte[0] as the high 8 bits and the high nibble of byte[2]
// as the low 4 bits; humidity uses byte[1] as the high 8 bits and the low
// nibble of byte[2] as the low 4 bits. Both are scaled by 0.1 (deci-units).
// The payload length must be a multiple of 3 bytes; upstream returns null
// otherwise, which we surface as an error.
//
// The OY1100 reports no battery telemetry in its uplink, so neither `battery`
// nor `batteryPercent` is emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length === 0 || bytes.length % 3 !== 0) {
    return { errors: ['payload length must be a non-zero multiple of 3 bytes'] };
  }

  var temperature = round((((bytes[0] << 4) | ((bytes[2] & 0xf0) >> 4)) * 0.1), 1);
  var relativeHumidity = round((((bytes[1] << 4) | (bytes[2] & 0x0f)) * 0.1), 1);

  return {
    data: {
      air: {
        temperature: temperature,
        relativeHumidity: relativeHumidity
      }
    }
  };
}
