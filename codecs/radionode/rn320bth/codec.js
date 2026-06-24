// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Radionode RN320-BTH (LoRaWAN temperature &
// humidity data logger).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Radionode RN320 head/model framed payload) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/radionode/rn320bth.js, attributed in NOTICE).
//
// Ported from the upstream decoder's frame parsing (head 11 check-in, head
// 12/13 sensor/hold), which is the source of truth for the byte layout:
//   * head 11 (check-in): config frame carrying battery state. The wire reports
//     millivolts (bytes[9..10], LE), so we emit it as the vocabulary `battery`
//     (volts). The raw 1..255 battery index (bytes[8]) is NOT a 0-100 percent,
//     so it is exposed as the camelCase extra `batteryLevel`, not forced into a
//     vocabulary field.
//   * head 12 (datain / live) and head 13 (holdin / buffered) carry the same
//     sensor layout: splfmt must be 2 (IEEE-754 float32 LE), then >=2 channels
//     of 4 bytes each. Channel 0 is temperature (degC) -> air.temperature,
//     channel 1 is humidity (%RH) -> air.relativeHumidity. The float read,
//     the 2-decimal rounding, and the <= -9999.0 sentinel (dropped value) all
//     mirror the upstream decoder exactly.
//   * The Unix epoch timestamp (bytes[3..6], LE) is surfaced as the vocabulary
//     `time` (RFC3339); head 13 (buffered) is flagged with the camelCase extra
//     frameType "hold" vs "live" so a consumer can tell live from back-filled.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(b, i) {
  return ((b[i + 1] << 8) | b[i]) & 0xffff;
}

function u32le(b, i) {
  return (
    (b[i] +
      b[i + 1] * 0x100 +
      b[i + 2] * 0x10000 +
      b[i + 3] * 0x1000000) >>> 0
  );
}

// IEEE-754 single-precision, little-endian. Mirrors the upstream readFloatLE.
function f32le(b, i) {
  var buf = new ArrayBuffer(4);
  var view = new DataView(buf);
  view.setUint8(0, b[i] & 0xff);
  view.setUint8(1, b[i + 1] & 0xff);
  view.setUint8(2, b[i + 2] & 0xff);
  view.setUint8(3, b[i + 3] & 0xff);
  return view.getFloat32(0, true);
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Unix epoch seconds -> RFC3339 UTC string.
function rfc3339(epochSeconds) {
  var d = new Date(epochSeconds * 1000);
  return (
    d.getUTCFullYear() +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    ':' +
    pad2(d.getUTCMinutes()) +
    ':' +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var head = bytes[0] & 0xff;

  if (head === 11) {
    // Check-in / config frame.
    if (bytes.length < 13) {
      return { errors: ['check-in frame truncated'] };
    }
    var millivolt = u16le(bytes, 9);
    var data = {
      battery: round(millivolt / 1000, 3),
      batteryLevel: bytes[8] & 0xff,
      reportInterval: u16le(bytes, 6),
      freqBand: bytes[11] & 0xff,
      subBand: bytes[12] & 0xff
    };
    return { data: data };
  }

  if (head === 12 || head === 13) {
    // Sensor (datain / holdin) frame.
    if (bytes.length < 8) {
      return { errors: ['sensor frame truncated'] };
    }
    var splfmt = bytes[7] & 0xff;
    if (splfmt !== 2) {
      return { errors: ['Unsupported Sensor Data Format: ' + splfmt] };
    }

    var rawSize = 4;
    var channelBytes = bytes.length - 8;
    var chCount = Math.floor(channelBytes / rawSize);
    if (chCount < 2) {
      return { errors: ['Unsupported Sensor Data Size: ' + chCount] };
    }

    var temperature = round(f32le(bytes, 8), 2);
    var humidity = round(f32le(bytes, 12), 2);

    var air = {};
    if (temperature > -9999) {
      air.temperature = temperature;
    }
    if (humidity > -9999) {
      air.relativeHumidity = humidity;
    }

    var out = {
      time: rfc3339(u32le(bytes, 3)),
      air: air,
      frameType: head === 13 ? 'hold' : 'live'
    };
    return { data: out };
  }

  return { errors: ['Unsupported head frame: ' + head] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "radionode";
    result.data.model = "rn320bth";
  }
  return result;
}
