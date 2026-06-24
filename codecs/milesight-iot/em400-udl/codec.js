// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM400-UDL (Ultrasonic Distance / Level
// Sensor with temperature and accelerometer/position).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em400-tld.js, attributed in NOTICE). Ported from that
// reference; the upstream normalizeUplink output is NOT copied — normalization
// is authored here.
//
// The EM400 reports an accelerometer-derived position as a discrete movement
// event (channel 0x05: "normal" vs "tilt"). A tilt is a position-change event,
// so it normalizes to action.motion.detected (true on tilt). Temperature maps
// to air.temperature; ultrasonic distance is a device-specific extra
// `distance` (mm). Milesight reports battery as a PERCENTAGE; the vocabulary's
// `battery` is volts, so it is emitted as the camelCase extra `batteryPercent`.

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

    // BATTERY (percent)
    if (channel === 0x01 && type === 0x75) {
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    }
    // TEMPERATURE
    else if (channel === 0x03 && type === 0x67) {
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    }
    // DISTANCE (mm)
    else if (channel === 0x04 && type === 0x82) {
      data.distance = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    }
    // POSITION (accelerometer): 0 = normal, else tilt -> motion event
    else if (channel === 0x05 && type === 0x00) {
      action.motion = { detected: bytes[i + 2] !== 0 };
      i += 3;
      recognized = true;
    }
    // TEMPERATURE WITH ABNORMAL FLAG
    else if (channel === 0x83 && type === 0x67) {
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      air.temperatureAbnormal = bytes[i + 4] !== 0;
      i += 5;
      recognized = true;
    }
    // DISTANCE WITH ALARM FLAG
    else if (channel === 0x84 && type === 0x82) {
      data.distance = u16le(bytes[i + 2], bytes[i + 3]);
      data.distanceAlarming = bytes[i + 4] !== 0;
      i += 5;
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
