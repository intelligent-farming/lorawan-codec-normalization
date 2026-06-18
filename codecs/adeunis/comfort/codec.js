// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Adeunis COMFORT (indoor Temperature & Humidity
// sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/adeunis/comfort_lib.js / comfort-codec,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Ported from: upstream codec.Decoder (deviceType 'comfort2') — its
// GenericStatusByteParser + Comfort2 0x4c data parser. Adeunis frames are a
// frame-code byte (payload[0]) + a status byte (payload[1]) followed by a
// per-frame-code body, so this is a status-byte + per-channel layout rather
// than a TLV stream.
//
// Frame layout (source of truth = reference/upstream-codec.js):
//   byte 0          frame code (0x4c = COMFORT data; others = config/keepalive/etc.)
//   byte 1          status byte:
//                     bits 7..5  frameCounter           (b1 & 0xe0) >> 5
//                     bit  3     configurationInconsistency (b1 & 0x08)
//                     bit  2     timestamp present       (b1 & 0x04)
//                     bit  1     lowBattery              (b1 & 0x02)
//                     bit  0     configurationDone       (b1 & 0x01)
//   0x4c body       N samples, 3 bytes each, sample[0] = most-recent (t=0):
//                     int16 BE  temperature  /10 -> °C
//                     uint8     humidity         -> %RH
//                   when timestamp bit set, the last 4 bytes are a uint32 BE
//                   seconds offset from 2013-01-01T00:00:00Z (epoch + 1356998400).
//
// Mapping decisions:
//   sample[0] temperature -> air.temperature        (vocabulary)
//   sample[0] humidity    -> air.relativeHumidity   (vocabulary)
//   device timestamp      -> top-level `time` (RFC3339) when the timestamp bit
//                            is set on a 0x4c data frame
//   prior samples         -> `temperatureHistory` / `humidityHistory` extras
//                            (oldest-last, matching upstream "[t=0, t-1, ...]").
//                            They are NOT emitted in the reserved `history`
//                            array because the data frame carries only the t=0
//                            timestamp and no per-sample sampling period, so a
//                            valid per-entry RFC3339 `time` cannot be derived.
//   status byte           -> frameType, frameCounter, lowBattery,
//                            configurationDone, configurationInconsistency extras
//
// Non-data frames (configuration, keep-alive, register/version/alarm, unknown)
// carry no temperature/humidity, so they return an error rather than a bare or
// climate-incomplete measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32be(b0, b1, b2, b3) {
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

function hexByte(b) {
  var s = b.toString(16);
  return '0x' + (s.length < 2 ? '0' + s : s);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short: expected at least a frame code and status byte'] };
  }

  var frameCode = bytes[0];
  var status = bytes[1];

  // The COMFORT only emits temperature/humidity on the 0x4c data frame.
  if (frameCode !== 0x4c) {
    return { errors: ['unsupported frame ' + hexByte(frameCode) + ': no temperature/humidity data'] };
  }

  var hasTimestamp = Boolean(status & 0x04);
  // When a timestamp is appended it occupies the last 4 bytes of the payload.
  var bodyEnd = hasTimestamp ? bytes.length - 4 : bytes.length;

  if (bodyEnd <= 2 || (bodyEnd - 2) % 3 !== 0) {
    return { errors: ['malformed 0x4c data frame: expected one or more 3-byte temperature/humidity samples'] };
  }

  var temperatures = [];
  var humidities = [];
  for (var offset = 2; offset < bodyEnd; offset += 3) {
    temperatures.push(round(s16be(bytes[offset], bytes[offset + 1]) / 10, 1));
    humidities.push(bytes[offset + 2]);
  }

  var data = {
    air: {
      location: 'indoor',
      temperature: temperatures[0],
      relativeHumidity: humidities[0]
    },
    frameType: hexByte(frameCode),
    frameCounter: (status & 0xe0) >> 5,
    lowBattery: Boolean(status & 0x02),
    configurationDone: Boolean(status & 0x01),
    configurationInconsistency: Boolean(status & 0x08)
  };

  if (hasTimestamp) {
    var epoch = u32be(
      bytes[bytes.length - 4],
      bytes[bytes.length - 3],
      bytes[bytes.length - 2],
      bytes[bytes.length - 1]
    );
    // Adeunis epoch is seconds since 2013-01-01T00:00:00Z (offset 1356998400).
    data.time = new Date((epoch + 1356998400) * 1000).toISOString();
  }

  // Preserve the prior samples (t-1, t-2, ...) without forcing invalid history
  // timestamps. Only present when the frame carried more than one sample.
  if (temperatures.length > 1) {
    data.temperatureHistory = temperatures.slice(1);
    data.humidityHistory = humidities.slice(1);
  }

  return { data: data };
}
