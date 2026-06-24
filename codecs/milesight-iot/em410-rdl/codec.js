// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM410-RDL (Radar Distance/Level
// Sensor with temperature and a position/tilt accelerometer).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em410-rdl.js, attributed in NOTICE). Ported from that
// reference; the normalization (vocabulary mapping) is authored here and does
// NOT reuse upstream normalizeUplink.
//
// Category `motion`: the device's POSITION channel (0x05/0x00) reports a
// discrete normal/tilt accelerometer state. A "tilt" is a position-change /
// movement event, mapped to action.motion.detected (tilt => true, normal =>
// false).
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. Radar distance (mm) and radar
// signal strength have no vocabulary key, so they ship as camelCase extras.

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

function decodeUplink(input) {
  var bytes = input.bytes;
  var data = {};
  var air = {};
  var action = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY (percent)
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE (0.1 °C)
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x82) {
      // DISTANCE (mm) — no vocabulary key, emit as extra
      data.distance = s16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // POSITION: 0 = normal, 1 = tilt. A tilt is a movement/position-change
      // event -> action.motion.detected.
      action.motion = { detected: bytes[i + 2] === 1 };
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0xc7) {
      // RADAR SIGNAL STRENGTH (0.01 dBm units) — extra
      data.radarSignalRssi = round(s16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }
  if (air.temperature !== undefined) {
    data.air = air;
  }
  if (action.motion !== undefined) {
    data.action = action;
  }
  return { data: data };
}
