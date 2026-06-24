// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM400-MUD (Multifunctional Ultrasonic
// Distance / Level Sensor with temperature and accelerometer/position).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/em400-mud.js,
// in turn Milesight-IoT/SensorDecoders, attributed in NOTICE). The channel-walk
// and field extraction are reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions:
//   0x01/0x75 battery            byte %                  -> batteryPercent extra
//   0x03/0x67 temperature        int16 LE /10 (°C)       -> air.temperature
//   0x04/0x82 distance           uint16 LE (mm)          -> distanceMm extra
//   0x05/0x00 position           byte 0=normal,else=tilt -> action.motion.detected
//   0x83/0x67 temperature+abn.   int16 LE /10, +flag     -> air.temperature, temperatureAbnormal
//   0x84/0x82 distance+alarm     uint16 LE, +flag        -> distanceMm, distanceAlarming
//
// The accelerometer/position channel (0x05/0x00) is the category-defining
// motion event: the device reports a discrete tilt-status CHANGE as normal vs
// tilt. That movement/position event is normalized to action.motion.detected
// (tilt => true, normal => false). Distance/level and temperature are not motion
// signals: distance has no vocabulary key, so it is emitted as the camelCase
// extra distanceMm (the EM400-MUD ultrasonic reading is in millimetres), and
// temperature is normalized to air.temperature. Milesight reports battery as a
// PERCENTAGE; the vocabulary's `battery` is volts, so the percentage is emitted
// as the camelCase extra batteryPercent rather than forced into a volts field.

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var hasAir = false;
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
      // TEMPERATURE (int16 LE, 0.1 °C)
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x82) {
      // DISTANCE (uint16 LE, mm)
      data.distanceMm = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // POSITION: 0 = normal, nonzero = tilt (discrete movement/tilt event)
      motion.detected = bytes[i + 2] !== 0;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x83 && type === 0x67) {
      // TEMPERATURE WITH ABNORMAL (int16 LE 0.1 °C, then abnormal flag byte)
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      data.temperatureAbnormal = bytes[i + 4] !== 0;
      hasAir = true;
      i += 5;
      recognized = true;
    } else if (channel === 0x84 && type === 0x82) {
      // DISTANCE WITH ALARMING (uint16 LE mm, then alarming flag byte)
      data.distanceMm = u16le(bytes[i + 2], bytes[i + 3]);
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

  if (hasAir) {
    data.air = air;
  }
  if (hasMotion) {
    data.action = { motion: motion };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "em400-mud";
  }
  return result;
}
