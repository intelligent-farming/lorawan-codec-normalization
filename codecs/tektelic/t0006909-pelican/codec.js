// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic PELICAN Enterprise Outdoor Tracker
// (T0006909) — a BLE asset tracker with an on-board accelerometer. Data uplinks
// (fPort 10) carry a discrete accelerometer motion alarm (move-detected event),
// battery voltage/end-of-service flag, on-board temperature and humidity, and a
// raw acceleration X/Y/Z vector.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on fPort 10, big-endian fields) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic t0006909-codec
// decoder_ble_tracker.js, attributed in NOTICE). Author the normalization here;
// upstream normalizeUplink is NOT copied.
//
// Mapping notes:
//   - accel_alarm_status (header 0x00 0x00) is the accelerometer move/motion
//     alarm on the DATA uplink: uint8, non-zero = movement detected ->
//     action.motion.detected (boolean). It is a discrete decoded event, not a
//     config register, so the `motion` category is genuinely satisfied.
//   - battery_status (header 0x00 0xBA) packs bit7 = end-of-service alert and
//     bits6..0 = battery level scaled (level * 0.01 + 2.5) VOLTS, range
//     2.50-3.77 V -> the vocabulary `battery` field (volts, not percent). The
//     end-of-service flag is surfaced as the extra `batteryEndOfService`.
//   - temperature (header 0x00 0x67) signed16 BE * 0.1 C -> air.temperature.
//   - relative_humidity (header 0x04 0x68) uint8 * 0.5 % -> air.relativeHumidity.
//   - acceleration x/y/z (header 0x00 0x71) signed16 BE * 0.001 g each -> the
//     camelCase extras accelerationX/Y/Z (raw axes are not a motion event).
//
// Non-data ports (BLE scan results, historical data, LoRaWAN/config registers,
// downlink ACKs) are not normalized measurements and are rejected.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first), matching the
// upstream unsigned accumulation.
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

function hex2(v) {
  return ('0' + (v === undefined ? 0 : v).toString(16)).slice(-2);
}

function decodeUplinkCore(input) {
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
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0x00) {
      // Accelerometer move/motion alarm: uint8, non-zero = movement detected.
      motion.detected = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x00 && type === 0xba) {
      // Battery status byte: bit7 = end-of-service alert, bits6..0 = level.
      // Battery voltage = (level * 0.01 + 2.5) V.
      var b = uintBE(bytes, i + 2, 1);
      data.battery = round((b & 0x7f) * 0.01 + 2.5, 2);
      extras.batteryEndOfService = (b & 0x80) > 0;
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
      // Acceleration vector x/y/z: signed16 BE * 0.001 g each -> extras.
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t0006909-pelican";
  }
  return result;
}
