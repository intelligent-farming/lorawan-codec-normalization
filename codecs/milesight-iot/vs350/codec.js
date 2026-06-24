// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS350 (Passage People Counter with
// temperature).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/vs350.js, in
// turn Milesight-IoT/SensorDecoders, attributed in NOTICE). The channel-walk
// and field extraction are reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions:
//   0x01/0x75 battery             byte %                 -> batteryPercent extra
//   0x03/0x67 temperature         int16 LE / 10 (degC)   -> air.temperature
//   0x04/0xcc total in/out        2x uint16 LE           -> totalIn / totalOut extras
//   0x05/0xcc period in/out       2x uint16 LE           -> action.motion (count/detected)
//   0x83/0x67 temperature alarm   int16 LE / 10 + flag   -> air.temperature + temperatureAlarm
//   0x84/0xcc total in/out alarm  2x uint16 LE + flag    -> totalIn/totalOut + totalCountAlarm
//   0x85/0xcc period in/out alarm 2x uint16 LE + flag    -> action.motion + periodCountAlarm
//
// This is a passage people counter: people crossing the passage are the motion
// events. The per-period passage counts (period_in + period_out) are the
// category-defining signal, mapped to action.motion.count, with
// action.motion.detected = true when any passage occurred this period. The
// cumulative lifetime counters (total_in / total_out) are device counters with
// no vocabulary home, emitted as camelCase extras. Milesight reports battery as
// a PERCENTAGE; the vocabulary's `battery` is volts, so the percentage is
// emitted as the camelCase extra `batteryPercent`. Temperature is mapped to
// air.temperature; the device has no humidity sensor, so this codec satisfies
// the motion category only (not climate).

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

function alarmType(t) {
  var map = {
    0: 'threshold alarm release',
    1: 'threshold alarm',
    3: 'high temperature alarm',
    4: 'high temperature alarm release'
  };
  var v = map[t];
  return v === undefined ? 'unknown' : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var hasMotion = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2] & 0xff;
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE (int16 LE, degC x10)
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0xcc) {
      // TOTAL IN / OUT (cumulative counters)
      data.totalIn = u16le(bytes[i + 2], bytes[i + 3]);
      data.totalOut = u16le(bytes[i + 4], bytes[i + 5]);
      i += 6;
      recognized = true;
    } else if (channel === 0x05 && type === 0xcc) {
      // PERIOD IN / OUT (passage events this period)
      motion.count = u16le(bytes[i + 2], bytes[i + 3]) + u16le(bytes[i + 4], bytes[i + 5]);
      motion.detected = motion.count > 0;
      hasMotion = true;
      i += 6;
      recognized = true;
    } else if (channel === 0x83 && type === 0x67) {
      // TEMPERATURE ALARM (int16 LE degC x10 + alarm flag)
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      data.temperatureAlarm = alarmType(bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (channel === 0x84 && type === 0xcc) {
      // TOTAL IN / OUT ALARM
      data.totalIn = u16le(bytes[i + 2], bytes[i + 3]);
      data.totalOut = u16le(bytes[i + 4], bytes[i + 5]);
      data.totalCountAlarm = alarmType(bytes[i + 6]);
      i += 7;
      recognized = true;
    } else if (channel === 0x85 && type === 0xcc) {
      // PERIOD IN / OUT ALARM
      motion.count = u16le(bytes[i + 2], bytes[i + 3]) + u16le(bytes[i + 4], bytes[i + 5]);
      motion.detected = motion.count > 0;
      data.periodCountAlarm = alarmType(bytes[i + 6]);
      hasMotion = true;
      i += 7;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasMotion) {
    data.action = { motion: motion };
  }
  if (air.temperature !== undefined) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "vs350";
  }
  return result;
}
