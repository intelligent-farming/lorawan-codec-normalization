// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic PELICAN Enterprise Outdoor Tracker
// (T0007377). The data uplink (fPort 10) reports an accelerometer movement
// alarm (motion event), battery status, ambient temperature, relative
// humidity, and the raw acceleration vector. BLE scan results (fPort 25),
// historical data (fPort 33) and the configuration/register frames (fPort 100)
// are not data measurements and are rejected.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on fPort 10, big-endian fields) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic decoder_ble_tracker.js,
// attributed in NOTICE). Author the normalization here; upstream decode/
// normalizeUplink output is NOT copied.
//
// Mapping notes:
//   - Battery status (header 0x00 0xBA): bits 6-0 are the cell voltage as
//     life * 0.01 + 2.5 V -> the vocabulary `battery` field (volts), NOT
//     batteryPercent. Bit 7 is an end-of-service alert -> extra
//     `batteryEndOfService` (boolean).
//   - accel_alarm_status (header 0x00 0x00): uint8 movement/motion alarm flag
//     -> action.motion.detected (boolean). This is the genuine motion event
//     for the tracker (the accelerometer trips an alarm when the asset moves),
//     so it satisfies the `motion` category. There is no separate motion-event
//     counter in the wire format, so action.motion.count is not produced.
//   - temperature (header 0x00 0x67): signed16 BE * 0.1 C -> air.temperature.
//   - relative_humidity (header 0x04 0x68): uint8 * 0.5 % -> air.relativeHumidity.
//   - acceleration x/y/z (header 0x00 0x71): three signed16 BE * 0.001 g ->
//     extras accelerationX/Y/Z (raw axes, not a motion event in themselves).

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
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected data uplink on fPort 10)'] };
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
    if (i + 1 >= bytes.length) {
      return { errors: ['truncated header at byte ' + i] };
    }
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xba) {
      // Battery status: bits 6-0 -> life * 0.01 + 2.5 V; bit 7 -> EOS alert.
      var b = bytes[i + 2] & 0xff;
      data.battery = round((b & 0x7f) * 0.01 + 2.5, 2);
      extras.batteryEndOfService = (b & 0x80) !== 0;
      i += 3;
    } else if (channel === 0x00 && type === 0x00) {
      // Accelerometer movement alarm: uint8 -> action.motion.detected.
      motion.detected = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x00 && type === 0x67) {
      // Ambient temperature: signed16 BE * 0.1 C -> air.temperature.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x04 && type === 0x68) {
      // Relative humidity: uint8 * 0.5 % -> air.relativeHumidity.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x00 && type === 0x71) {
      // Acceleration x/y/z: three signed16 BE * 0.001 g -> extras.
      extras.accelerationX = round(intBE(bytes, i + 2, 2) * 0.001, 3);
      extras.accelerationY = round(intBE(bytes, i + 4, 2) * 0.001, 3);
      extras.accelerationZ = round(intBE(bytes, i + 6, 2) * 0.001, 3);
      i += 8;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' + hex2(channel) + ' 0x' + hex2(type) + ' at byte ' + i,
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
