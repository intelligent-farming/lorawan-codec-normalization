// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Browan TBMS100 (Tabs Motion Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/tbms100.js, attributed in
// NOTICE). Ported from that upstream decodeUplink; the normalization here is
// authored for this module — do NOT treat upstream normalization as our output.
//
// Uplinks arrive on FPort 102 with a fixed 8-byte layout:
//   byte 0    status flags — bit 0 is the PIR motion state (1 = motion
//             detected, 0 = idle).
//   byte 1    battery: a 4-bit level (low nibble) mapped to volts as
//             (25 + level) / 10, yielding 2.5 V .. 4.0 V, which matches the
//             vocabulary's `battery` (volts), so it is emitted there directly.
//   byte 2    internal board temperature, °C: (val & 0x7f) - 32.
//   bytes 3-4 little-endian seconds since the previous motion event.
//   bytes 5-7 little-endian 24-bit cumulative motion-event counter (the total
//             number of motion events the device has registered).
//
// The PIR state maps to the boolean vocabulary key `action.motion.detected`;
// the cumulative event counter maps to `action.motion.count`. byte 2 is the
// device's own internal board temperature (not an ambient air sensor), so it is
// emitted as the camelCase extra `boardTemperature` rather than
// `air.temperature`. The seconds-since-last-event value has no vocabulary key
// and is emitted as the camelCase extra `timeSinceLastEvent`.
//
// NOTE: upstream's normalizeUplink labels byte 2 as `air.temperature` and drops
// the event counter; both are corrected here. Upstream also returns a bare {}
// for an empty/all-zero payload, which violates this module's output contract
// (never return bare {}), so an empty payload is reported as an error instead.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  var allZero = true;
  var i;
  for (i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (bytes.length === 0 || allZero) {
    return { errors: ['empty payload'] };
  }

  if (input.fPort !== 102) {
    return { errors: ['unknown FPort'] };
  }

  if (bytes.length < 8) {
    return { errors: ['payload too short'] };
  }

  var detected = (bytes[0] & 0x01) === 1;
  var battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);
  var boardTemperature = (bytes[2] & 0x7f) - 32;
  var timeSinceLastEvent = (bytes[4] << 8) | bytes[3];
  var count = ((bytes[7] << 16) | (bytes[6] << 8)) | bytes[5];

  return {
    data: {
      battery: battery,
      boardTemperature: round(boardTemperature, 1),
      timeSinceLastEvent: timeSinceLastEvent,
      action: {
        motion: {
          detected: detected,
          count: count
        }
      }
    }
  };
}
