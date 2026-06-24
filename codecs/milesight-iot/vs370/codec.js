// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS370 (Radar Human Presence Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/vs370.js, attributed in NOTICE).
//
// Channels:
//   0x01/0x75 battery — PERCENTAGE. The vocabulary `battery` is volts, so the
//     percentage is emitted as the camelCase extra `batteryPercent`, never
//     forced into a volts field.
//   0x03/0x00 occupancy — radar/PIR human presence. The wire byte is a boolean
//     state (0 = vacant, 1 = occupied), NOT an event count. Mapped to
//     action.motion.detected (occupied => true). There is no count on this
//     device, so action.motion.count is intentionally omitted.
//   0x04/0x00 illuminance — a CATEGORICAL ambient-light level (0 = dim,
//     1 = bright, 254 = disabled), NOT a lux measurement. The vocabulary
//     `air.lightIntensity` is lux (a number); a level string would violate that
//     type, so the level is emitted as the camelCase extra `illuminanceLevel`
//     and the device does NOT satisfy the `light` category.
//
// Diagnostic/config TLVs (0xff version & device-status channels, downlink
// responses on 0xfe/0xff/0xf8/0xf9) carry no normalized measurement and are not
// decoded here; the loop stops at the first unrecognized channel.

function readIlluminanceLevel(v) {
  if (v === 0) {
    return 'dim';
  }
  if (v === 1) {
    return 'bright';
  }
  if (v === 254) {
    return 'disabled';
  }
  return 'unknown';
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
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x00) {
      // OCCUPANCY: boolean presence state (0 vacant, 1 occupied)
      motion.detected = bytes[i + 2] === 1;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x04 && type === 0x00) {
      // ILLUMINANCE: categorical level, not lux -> camelCase extra
      data.illuminanceLevel = readIlluminanceLevel(bytes[i + 2]);
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
    result.data.model = "vs370";
  }
  return result;
}
