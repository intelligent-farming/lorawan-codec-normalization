// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight WS202 (PIR & Light occupancy sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/ws202.js, attributed in NOTICE). Do NOT copy upstream
// normalizeUplink; the normalization below is authored against the wire format.
//
// Channels:
//   0x01/0x75 battery  : 1 byte PERCENTAGE. The vocabulary `battery` is volts,
//                        so the percentage is emitted as the camelCase extra
//                        `batteryPercent` rather than forced into a volts field.
//   0x03/0x00 PIR      : 1 byte occupancy state, 0 = "normal" (idle), non-zero =
//                        "trigger" (motion). Mapped to action.motion.detected
//                        (boolean): trigger -> true, normal -> false. The WS202
//                        reports a coarse trigger/idle state, not an event count,
//                        so action.motion.count is intentionally omitted.
//   0x04/0x00 light    : 1 byte CATEGORICAL light state, 0 = "dark", non-zero =
//                        "light". This is NOT a numeric illuminance, so it cannot
//                        satisfy air.lightIntensity (lux). It is emitted as the
//                        camelCase extra `lightLevel` (string "dark"/"light").

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
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
      // BATTERY: 1 byte percentage
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x00) {
      // PIR: 1 byte occupancy state (0 = idle, non-zero = motion trigger)
      motion.detected = bytes[i + 2] !== 0;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x04 && type === 0x00) {
      // LIGHT: 1 byte categorical light state (0 = dark, non-zero = light).
      // Not a numeric lux value -> camelCase extra, not air.lightIntensity.
      data.lightLevel = bytes[i + 2] === 0 ? 'dark' : 'light';
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
    result.data.model = "ws202";
  }
  return result;
}
