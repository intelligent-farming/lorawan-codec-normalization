// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Adeunis Comfort CO2 (indoor air-quality sensor:
// temperature, relative humidity, CO2).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Adeunis frame-code + status-byte framing) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/adeunis/comfort_co2_lib.js, attributed in NOTICE). The normalization
// below is authored here; the upstream `decodeUplink` (which nests everything
// under `data.bytes` and never errors) is NOT copied.
//
// The 0x6a data frame carries one or more [temperature, humidity, CO2] samples
// ordered newest-first ([t=0, t-1, t-2, ...]). The newest sample (t=0) is
// normalized to the top-level `air.*` keys; any older samples are exposed in the
// camelCase extra `samples` (newest-first, matching the wire order). Frame type,
// status flags and the optional frame timestamp are camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(bytes, offset) {
  return bytes[offset] & 0xff;
}

function s16be(bytes, offset) {
  var v = ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u16be(bytes, offset) {
  return (((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)) & 0xffff;
}

function u32be(bytes, offset) {
  return (
    ((bytes[offset] & 0xff) * 0x1000000) +
    (((bytes[offset + 1] & 0xff) << 16) |
      ((bytes[offset + 2] & 0xff) << 8) |
      (bytes[offset + 3] & 0xff))
  );
}

// Adeunis epoch: seconds since 2013-01-01T00:00:00Z, offset by 1356998400 from
// the Unix epoch. Returns an RFC3339 string.
function decodeTimestamp(bytes, offset) {
  var secs = u32be(bytes, offset) + 1356998400;
  return new Date(secs * 1000).toISOString();
}

// Status byte (payload[1]) common to every Comfort CO2 frame.
function decodeStatus(status) {
  return {
    frameCounter: (status & 0xe0) >> 5,
    lowBattery: Boolean(status & 0x02),
    configurationDone: Boolean(status & 0x01),
    configurationInconsistency: Boolean(status & 0x08)
  };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var frameCode = bytes[0];
  if (frameCode !== 0x6a) {
    return {
      errors: [
        'unsupported frame code 0x' + frameCode.toString(16) +
          ' (only the 0x6a data frame is normalized)'
      ]
    };
  }

  var statusByte = bytes[1];
  var hasTimestamp = Boolean(statusByte & 0x04);
  var dataEnd = hasTimestamp ? bytes.length - 4 : bytes.length;

  var samples = [];
  var offset;
  for (offset = 2; offset + 5 <= dataEnd; offset += 5) {
    samples.push({
      temperature: round(s16be(bytes, offset) / 10, 1),
      relativeHumidity: u8(bytes, offset + 2),
      co2: u16be(bytes, offset + 3)
    });
  }

  if (samples.length === 0) {
    return { errors: ['0x6a data frame contained no samples'] };
  }

  var current = samples[0];
  var data = {
    frameType: '0x6a data',
    air: {
      temperature: current.temperature,
      relativeHumidity: current.relativeHumidity,
      co2: current.co2
    }
  };

  var status = decodeStatus(statusByte);
  data.frameCounter = status.frameCounter;
  data.lowBattery = status.lowBattery;
  data.configurationDone = status.configurationDone;
  data.configurationInconsistency = status.configurationInconsistency;

  if (hasTimestamp) {
    data.time = decodeTimestamp(bytes, dataEnd);
  }

  if (samples.length > 1) {
    data.samples = samples;
  }

  return { data: data };
}
