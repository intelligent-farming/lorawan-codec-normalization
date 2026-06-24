// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic SPARROW Enterprise Asset Tracker
// (T0007xxx). On the data uplink (fPort 10) the device reports an accelerometer
// motion alarm (state), 3-axis acceleration, battery status, ambient
// temperature and relative humidity.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic 2-byte channel/type headers on fPort 10, big-endian fields)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_sparrow_enterprise_asset_tracker.js, attributed in NOTICE). Author the
// normalization here; upstream normalizeUplink is NOT copied.
//
// Mapping notes:
//   - accel_alarm_status (header 0x00 0x00) is a genuine real-time accelerometer
//     motion-alarm event/state (uint8, non-zero => motion). It maps to
//     action.motion.detected (boolean). The accelerometer *configuration*
//     registers (sensitivity, thresholds, sample rate, event count/period) live
//     on fPort 100 and are not decoded here — only the live motion event is.
//   - acceleration x/y/z (header 0x00 0x71) are signed16 BE * 0.001 g raw axis
//     readings, surfaced as camelCase extras (accelerationX/Y/Z), not motion.
//   - battery_status (header 0x00 0xBA): bit7 is an end-of-service alert flag
//     (extra batteryEosAlert); bits6-0 encode battery life as
//     (raw * 0.01 + 2.5) VOLTS -> vocabulary `battery` (not a percentage).
//   - temperature (header 0x00 0x67) signed16 BE * 0.1 C -> air.temperature.
//   - relative_humidity (header 0x04 0x68) uint8 * 0.5 % -> air.relativeHumidity.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first).
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

function hex2(b) {
  return ('0' + (b === undefined ? 0 : b).toString(16).toUpperCase()).slice(-2);
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
    var c0 = bytes[i];
    var c1 = bytes[i + 1];

    if (c0 === 0x00 && c1 === 0x00) {
      // Accelerometer motion alarm state: uint8 -> action.motion.detected.
      motion.detected = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (c0 === 0x00 && c1 === 0x71) {
      // Acceleration vector x/y/z: signed16 BE * 0.001 g -> extras.
      extras.accelerationX = round(intBE(bytes, i + 2, 2) * 0.001, 3);
      extras.accelerationY = round(intBE(bytes, i + 4, 2) * 0.001, 3);
      extras.accelerationZ = round(intBE(bytes, i + 6, 2) * 0.001, 3);
      i += 8;
    } else if (c0 === 0x00 && c1 === 0xba) {
      // Battery status: bit7 EOS alert; bits6-0 battery life as volts.
      var raw = uintBE(bytes, i + 2, 1);
      extras.batteryEosAlert = (raw & 0x80) > 0;
      data.battery = round((raw & 0x7f) * 0.01 + 2.5, 2);
      i += 3;
    } else if (c0 === 0x00 && c1 === 0x67) {
      // Ambient temperature: signed16 BE * 0.1 C.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (c0 === 0x04 && c1 === 0x68) {
      // Relative humidity: uint8 * 0.5 %.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else {
      return {
        errors: ['unrecognized channel/type 0x' + hex2(c0) + ' 0x' + hex2(c1) + ' at byte ' + i],
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
