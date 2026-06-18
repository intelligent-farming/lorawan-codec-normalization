// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Teneo IoT Filling Degree Sensor (LoRaWAN
// ultrasonic/laser fill-level sensor for waste bins/containers, with optional
// onboard temperature and humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/teneo-iot/filling-degree-sensor.js,
// attributed in NOTICE). Ported from that decoder; do NOT copy upstream
// normalizeUplink as our output.
//
// Wire format (big-endian):
//   byte 0       : battery, volts = 2 + byte0 / 10
//   fPort 1 (measurement):
//     bytes 1..2 : distance (cm), big-endian uint16
//     len 3      : distance only
//     len 7      : distance + bytes 3..4 temperature x100 + bytes 5..6 humidity x100
//     len 4      : distance + byte 3 status (0 = ok; 4 = no-echo, distance = -1
//                  but valid; any other non-zero = error, errorCode = status)
//     len 8      : as len 4 plus bytes 4..5 temperature x100 + bytes 6..7 humidity x100
//     other len  : invalid frame, errorCode = -1
//   fPort 2 (status only): byte 1 code (4 = no-echo, distance = -1 valid;
//                  otherwise error, errorCode = code)
//   fPort 3      : charging frame (no measurement)
//   empty bytes  : valid = false, nothing else decodable
//
// This device reports battery as VOLTS, so it maps to the vocabulary `battery`
// (not `batteryPercent`). Temperature -> air.temperature and humidity ->
// air.relativeHumidity. Fill level has no vocabulary key, so it is emitted as
// the camelCase extra `distance` (cm). Device status flags (sensorType, valid,
// charging, settingsAllowed, errorCode) are device-specific and emitted as
// camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  data.sensorType = 'fillrate';
  data.settingsAllowed = true;
  data.charging = false;
  data.battery = round(2 + bytes[0] / 10, 1);

  if (input.fPort === 1) {
    // Distance-only payload (len 3) or distance + temp/humidity (len 7).
    if (bytes.length === 3 || bytes.length === 7) {
      data.valid = true;
      data.distance = u16be(bytes[1], bytes[2]);
      if (bytes.length === 7) {
        data.air = {
          temperature: round(u16be(bytes[3], bytes[4]) / 100, 2),
          relativeHumidity: round(u16be(bytes[5], bytes[6]) / 100, 2)
        };
      }
    }
    // Distance + status payload (len 4) or with temp/humidity (len 8).
    else if (bytes.length === 4 || bytes.length === 8) {
      data.valid = true;
      data.distance = u16be(bytes[1], bytes[2]);
      var statusCode = bytes[3];
      if (statusCode !== 0) {
        if (statusCode === 4) {
          data.valid = true;
          data.distance = -1;
        } else {
          data.valid = false;
          data.errorCode = statusCode;
        }
      }
      if (bytes.length === 8) {
        data.air = {
          temperature: round(u16be(bytes[4], bytes[5]) / 100, 2),
          relativeHumidity: round(u16be(bytes[6], bytes[7]) / 100, 2)
        };
      }
    } else {
      data.valid = false;
      data.errorCode = -1;
    }
  } else if (input.fPort === 2) {
    var code = bytes[1];
    if (code === 4) {
      data.valid = true;
      data.distance = -1;
    } else {
      data.valid = false;
      data.errorCode = code;
    }
  } else if (input.fPort === 3) {
    data.valid = false;
    data.charging = true;
  } else {
    return { errors: ['unsupported fPort: ' + input.fPort] };
  }

  return { data: data };
}
