// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS330 (PIR Occupancy Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/vs330.js, in
// turn Milesight-IoT/SensorDecoders, attributed in NOTICE). The channel-walk
// and field extraction are reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions:
//   0x01/0x75 battery      byte %                       -> batteryPercent extra
//   0x02/0x82 distance     uint16 LE (mm)               -> distance extra (mm)
//   0x03/0x8e occupancy    byte (0 = vacant, else occ)  -> action.motion.detected
//   0x04/0x8e calibration  byte (0 = failed, else ok)   -> calibrationSuccess extra
//
// The PIR occupancy channel is the category-defining state: occupied/motion is
// reported as action.motion.detected (boolean). Milesight reports battery as a
// PERCENTAGE; the vocabulary's `battery` is volts, so the percentage is emitted
// as the camelCase extra `batteryPercent` rather than forced into a volts field.
// Distance (a device-info channel) and calibration status are emitted as
// camelCase extras.

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var action = {};
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
    } else if (channel === 0x02 && type === 0x82) {
      // DISTANCE (uint16 LE, mm)
      data.distance = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x03 && type === 0x8e) {
      // OCCUPANCY: byte, 0 = vacant, nonzero = occupied
      motion.detected = bytes[i + 2] !== 0;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x04 && type === 0x8e) {
      // CALIBRATION: byte, 0 = failed, nonzero = success
      data.calibrationSuccess = bytes[i + 2] !== 0;
      i += 3;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasMotion) {
    action.motion = motion;
    data.action = action;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "vs330";
  }
  return result;
}
