// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM102L (indoor 2-in-1 ambient
// temperature & humidity sensor).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/milesight-iot/am102l.js, attributed
// in NOTICE). The upstream Milesight channel/type TLV decoder is the source of
// truth for the wire format; the normalization to vocabulary keys is authored
// here. Do NOT copy upstream normalizeUplink.
//
// Mapping decisions:
//   0x01/0x75 battery      uint8 %            -> batteryPercent extra
//   0x03/0x67 temperature  int16 LE /10 °C    -> air.temperature
//   0x04/0x68 humidity      uint8 /2 %         -> air.relativeHumidity
//   0x20/0xce datalog       epoch + temp + hum -> history[] (RFC3339 time)
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. The datalog channel carries
// timestamped prior readings; those map to the vocabulary `history` array while
// the current reading stays at the top level.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 % resolution
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      // DATALOG: epoch(uint32 LE) + temperature(int16 LE /10) + humidity(/2)
      var epoch = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      var point = {
        air: {
          temperature: round(s16le(bytes[i + 6], bytes[i + 7]) / 10, 1),
          relativeHumidity: round(bytes[i + 8] / 2, 1)
        }
      };
      if (epoch > 0) {
        point.time = new Date(epoch * 1000).toISOString();
      }
      if (!data.history) {
        data.history = [];
      }
      data.history.push(point);
      i += 9;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
