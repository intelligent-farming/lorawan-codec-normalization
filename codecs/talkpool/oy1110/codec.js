// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TalkPool OY1110 (LoRaWAN temperature and
// humidity sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Decode
// logic ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/talkpool/oy1110.js, attributed in
// NOTICE) — that decoder is the source of truth for the wire format.
//
// Wire format (3-byte packed reading):
//   Temperature      (0.1 degC) = (((bytes[0] << 4) | (bytes[2] >> 4))   - 800) / 10
//   RelativeHumidity (0.1 %)    = (((bytes[1] << 4) | (bytes[2] & 0x0F)) - 250) / 10
// fPort 2 carries one or more 3-byte readings (length % 3 === 0); upstream
// decodes only the first reading, so we do the same. fPort 3 is a datalog
// frame: a 1-byte header followed by 3-byte readings (length % 3 === 1); after
// dropping the header, the first reading is decoded the same way.
//
// The OY1110 reports only temperature and relative humidity — no battery and no
// CO2 — so this codec emits air.temperature (degC) and air.relativeHumidity (%)
// only. Upstream returns { data: null } for malformed frames and unknown ports;
// our output contract forbids null data, so those cases return { errors: [...] }.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeReading(b0, b1, b2) {
  var temperature = round(((((b0 << 4) | ((b2 & 0xf0) >> 4)) - 800) / 10), 1);
  var relativeHumidity = round(((((b1 << 4) | (b2 & 0x0f)) - 250) / 10), 1);
  return {
    air: {
      temperature: temperature,
      relativeHumidity: relativeHumidity
    }
  };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort === 2) {
    if (bytes.length === 0 || bytes.length % 3 !== 0) {
      return { errors: ['fPort 2 payload length must be a non-zero multiple of 3'] };
    }
    return { data: decodeReading(bytes[0], bytes[1], bytes[2]) };
  }

  if (fPort === 3) {
    if (bytes.length % 3 !== 1 || bytes.length < 4) {
      return { errors: ['fPort 3 payload length must be a 1-byte header plus a non-zero multiple of 3'] };
    }
    return { data: decodeReading(bytes[1], bytes[2], bytes[3]) };
  }

  return { errors: ['unsupported fPort ' + fPort + ' (expected 2 or 3)'] };
}
