// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic PELICAN EX Enterprise ATEX Outdoor
// Tracker (T0007367), a BLE asset tracker with an accelerometer used for
// event-based (motion) start-up. The data uplink (fPort 10) reports an
// accelerometer motion-alarm event, the raw 3-axis acceleration vector, device
// battery, and on-board temperature/humidity.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on fPort 10, big-endian fields) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic decoder_ble_tracker.js,
// attributed in NOTICE). Author the normalization here; upstream normalizeUplink
// is NOT copied.
//
// Mapping notes:
//   - accel_alarm_status (channel/type 0x00 0x00) is the accelerometer
//     motion-alarm event reported in telemetry (a genuine decoded motion event,
//     not a config register) -> action.motion.detected (boolean). This is the
//     channel that satisfies the `motion` category.
//   - acceleration x/y/z (channel/type 0x00 0x71) is the raw 3-axis vector,
//     signed16 BE * 0.001 g -> camelCase extras accelerationX/Y/Z (the
//     vocabulary does not model a calibrated acceleration vector).
//   - battery_status (channel/type 0x00 0xBA): high bit is an end-of-service
//     alert (extra batteryEndOfServiceAlert); the low 7 bits are battery voltage
//     as (n * 0.01 + 2.5) V -> the vocabulary `battery` field (volts, not
//     percent).
//   - temperature (0x00 0x67) signed16 BE * 0.1 C -> air.temperature.
//   - relative_humidity (0x04 0x68) uint8 * 0.5 % -> air.relativeHumidity.
//   - BLE-scan uplinks (fPort 100) carry device-discovery / scan-config data,
//     not motion, and are out of scope for this motion codec.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first), matching the
// upstream "unsigned" accumulation.
function uintBE(bytes, offset, length) {
  var out = 0;
  for (var i = 0; i < length; i++) {
    out = out * 256 + (bytes[offset + i] & 0xff);
  }
  return out;
}

// Big-endian signed (two's complement) integer from a byte slice.
function intBE(bytes, offset, length) {
  var out = uintBE(bytes, offset, length);
  var max = Math.pow(2, 8 * length);
  if (out >= max / 2) {
    out -= max;
  }
  return out;
}

function hex2(n) {
  return ('0' + (n === undefined ? 0 : n).toString(16)).slice(-2);
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return {
      errors: ['unsupported fPort ' + input.fPort + ' (expected accelerometer data uplink on fPort 10)'],
    };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var extras = {};
  var i = 0;

  while (i < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xba) {
      // Battery status: bit7 = end-of-service alert, bits6-0 = (n * 0.01 + 2.5) V.
      var b = uintBE(bytes, i + 2, 1);
      extras.batteryEndOfServiceAlert = (b & 0x80) !== 0;
      data.battery = round((b & 0x7f) * 0.01 + 2.5, 2);
      i += 3;
    } else if (channel === 0x00 && type === 0x00) {
      // Accelerometer motion-alarm event: uint8 -> action.motion.detected.
      motion.detected = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x00 && type === 0x67) {
      // On-board temperature: signed16 BE * 0.1 C.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x04 && type === 0x68) {
      // Relative humidity: uint8 * 0.5 %.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x00 && type === 0x71) {
      // Acceleration vector x/y/z: signed16 BE * 0.001 g -> extras.
      extras.accelerationX = round(intBE(bytes, i + 2, 2) * 0.001, 3);
      extras.accelerationY = round(intBE(bytes, i + 4, 2) * 0.001, 3);
      extras.accelerationZ = round(intBE(bytes, i + 6, 2) * 0.001, 3);
      i += 8;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' + hex2(channel) + '/0x' + hex2(type) + ' at byte ' + i,
        ],
      };
    }
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }
  if (motion.detected !== undefined || motion.count !== undefined) {
    data.action = { motion: motion };
  }

  var extraKeys = [];
  var k;
  for (k in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, k)) {
      extraKeys.push(k);
    }
  }
  for (var j = 0; j < extraKeys.length; j++) {
    data[extraKeys[j]] = extras[extraKeys[j]];
  }

  var hasData = false;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    return { errors: ['no decodable measurements in payload'] };
  }

  return { data: data };
}
