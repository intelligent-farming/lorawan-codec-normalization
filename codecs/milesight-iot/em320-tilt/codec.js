// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM320-TILT (Tilt/Angle Sensor with
// 3-axis accelerometer).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/em320-tilt.js,
// in turn Milesight-IoT/SensorDecoders, attributed in NOTICE). The channel-walk
// and field extraction are reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions:
//   0x01/0x75 battery   byte %                          -> batteryPercent extra
//   0x03/0xd4 angle      3 x int16 LE; per axis the low
//                        bit of the raw word is a tilt
//                        threshold-CHANGE alarm flag and
//                        the angle is (raw >> 1) / 100 deg
//                          - tilt alarm (any axis triggered) -> action.motion.detected
//                          - continuous angles               -> angleX/angleY/angleZ extras
//
// The EM320-TILT reports both continuous 3-axis tilt angles and a per-axis tilt
// threshold alarm. The alarm is a discrete tilt-CHANGE / movement event: the
// device raises it when an axis crosses its configured tilt threshold. That
// event is the category-defining state and is mapped to
// action.motion.detected (true when any axis is in the triggered state). The
// raw continuous angles are not motion events on their own, so they are emitted
// as the camelCase extras angleX / angleY / angleZ (degrees).
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than forced into a volts field.

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
    } else if (channel === 0x03 && type === 0xd4) {
      // ANGLE: 3 x int16 LE. Low bit of each raw word is the per-axis tilt
      // threshold alarm flag; the angle is (raw >> 1) / 100 degrees.
      var rawX = s16le(bytes[i + 2], bytes[i + 3]);
      var rawY = s16le(bytes[i + 4], bytes[i + 5]);
      var rawZ = s16le(bytes[i + 6], bytes[i + 7]);

      data.angleX = round((rawX >> 1) / 100, 2);
      data.angleY = round((rawY >> 1) / 100, 2);
      data.angleZ = round((rawZ >> 1) / 100, 2);

      var triggered =
        (bytes[i + 2] & 0x01) === 0x01 ||
        (bytes[i + 4] & 0x01) === 0x01 ||
        (bytes[i + 6] & 0x01) === 0x01;
      motion.detected = triggered;
      hasMotion = true;

      i += 8;
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

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "em320-tilt";
  }
  return result;
}
