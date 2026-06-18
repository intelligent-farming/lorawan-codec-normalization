// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM300-MCS (Magnet Contact Switch /
// Door & Window Sensor with Temperature & Humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em300-mcs.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping decisions:
//   0x01/0x75 battery         byte %                 -> batteryPercent extra
//   0x03/0x67 temperature     int16 LE /10 °C        -> air.temperature
//   0x04/0x68 humidity        byte /2 %              -> air.relativeHumidity
//   0x06/0x00 magnet status   byte (0=close,1=open)  -> action.contactState
//                                                       ('closed' | 'open')
//   0x20/0xCE history datalog uint32 LE epoch (s)    -> history[].time (RFC3339)
//                             int16 LE /10 °C        -> history[].air.temperature
//                             byte /2 %              -> history[].air.relativeHumidity
//                             byte (0=close,1=open)  -> history[].action.contactState
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field.
//
// The magnet (reed/hall-effect) sensor reports door state. Upstream maps the
// raw byte to the strings "close"/"open"; the vocabulary's `action.contactState`
// enum is "closed"/"open", so 0 ("close") -> "closed" and 1 ("open") -> "open".
// This is a contact sensor, so the state is emitted as `action.contactState`
// and NOT as `action.motion` (a known upstream copy-paste bug for door sensors).
//
// Per AUTHORING.md, datalog (history) uplinks put the current reading at the
// top level and prior readings in a `history` array; every history entry
// carries an RFC3339 `time` derived from the device's Unix-epoch timestamp.
// The upstream decoder exposes the raw `timestamp` (epoch seconds); we
// normalize it to `time`.

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

function contactState(raw) {
  // Milesight magnet status: 0 = magnet present (door closed), 1 = open.
  return raw === 1 ? 'open' : 'closed';
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var action = {};
  var hasAir = false;
  var hasAction = false;
  var history = [];
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
    } else if (channel === 0x06 && type === 0x00) {
      // MAGNET STATUS: contact state (0 = closed, 1 = open)
      action.contactState = contactState(bytes[i + 2]);
      hasAction = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      // HISTORY DATALOG: epoch(u32 LE) + temp(i16 LE /10) + hum(byte /2)
      //                  + magnet status(byte)
      var epoch = u32le(
        bytes[i + 2],
        bytes[i + 3],
        bytes[i + 4],
        bytes[i + 5]
      );
      history.push({
        time: new Date(epoch * 1000).toISOString(),
        air: {
          temperature: round(s16le(bytes[i + 6], bytes[i + 7]) / 10, 1),
          relativeHumidity: round(bytes[i + 8] / 2, 1)
        },
        action: {
          contactState: contactState(bytes[i + 9])
        }
      });
      i += 10;
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
  if (hasAction) {
    data.action = action;
  }
  if (history.length > 0) {
    data.history = history;
  }

  return { data: data };
}
