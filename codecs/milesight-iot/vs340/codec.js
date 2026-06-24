// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS340 / VS341 (Desk & Seat PIR
// Occupancy Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/vs340.js, in
// turn Milesight-IoT/SensorDecoders, attributed in NOTICE). The channel-walk
// and field extraction are reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions:
//   0x01/0x75 battery      byte %                    -> batteryPercent extra
//   0x03/0x00 occupancy    byte (0 = vacant)         -> action.motion.detected
//
// The VS340 is a PIR occupancy sensor: the occupancy channel is a boolean
// presence flag (upstream maps it to the strings 'vacant' / 'occupied'). The
// normalized codec emits action.motion.detected = true when the seat/desk is
// occupied (PIR motion present), false when vacant. The wire format carries no
// motion-event counter, so action.motion.count is not emitted.
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field.

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
    } else if (channel === 0x03 && type === 0x00) {
      // OCCUPANCY: byte, 0 = vacant, nonzero = occupied
      motion.detected = bytes[i + 2] !== 0;
      hasMotion = true;
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
    data.action = { motion: motion };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "vs340";
  }
  return result;
}
