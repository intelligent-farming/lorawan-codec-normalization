// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TalkPool OY1200 (LoRaWAN CO2 meter:
// CO2 + temperature + humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/talkpool/oy1200.js, attributed in
// NOTICE): fPort 1, fixed 12-byte payload, four big-endian uint16 fields —
// CO2 raw (ppm), CO2 filtered (ppm), temperature (x100 C), humidity (x100 %).
// Upstream returns null for the wrong port/length; we return an error instead.
//
// The filtered CO2 reading is the device's processed measurement and maps to
// the vocabulary key air.co2. The raw CO2 reading has no vocabulary key and is
// emitted as the camelCase extra co2Raw (a vendor diagnostic).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 1) {
    return { errors: ['unsupported fPort ' + port + ' (expected 1)'] };
  }
  if (bytes.length !== 12) {
    return { errors: ['unexpected payload length ' + bytes.length + ' (expected 12)'] };
  }

  var co2Raw = u16be(bytes[2], bytes[3]);
  var co2Filtered = u16be(bytes[4], bytes[5]);
  var temperature = round(u16be(bytes[6], bytes[7]) / 100, 2);
  var humidity = round(u16be(bytes[8], bytes[9]) / 100, 2);

  var data = {
    air: {
      temperature: temperature,
      relativeHumidity: humidity,
      co2: co2Filtered
    },
    co2Raw: co2Raw
  };

  return { data: data };
}
