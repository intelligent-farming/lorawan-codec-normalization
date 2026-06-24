// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for STMicroelectronics STEVAL-ASTRA1B (multi-sensor
// development board: barometric pressure, temperature, humidity, 3-axis
// acceleration, GNSS position + altitude, and battery voltage).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/stmicroelectronics/steval-astra1b.js,
// attributed in NOTICE). The upstream type/value TLV extraction and indexing
// (data bytes span bytes[i+1]..bytes[i+len]; the cursor advances by len+2) is
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream normalizeUplink output).
//
// All measurements arrive on fPort 99 as a TLV stream: bytes[0] is ignored,
// then each entry is a 1-byte type code, value bytes, and trailing padding:
//   0x73 pressure    code/10 hPa            -> air.pressure (only if 900-1100)
//   0x67 temperature (signed) code/10 °C    -> air.temperature
//   0x68 humidity    code/2 %RH             -> air.relativeHumidity
//   0x71 accel XYZ   three signed mg ints   -> accelerationOnX/Y/Z (extras)
//   0x88 lat/lon/alt signed /10000 deg,     -> position.latitude /
//                    altitude /100 mslm         position.longitude, altitudeM
//   0x02 battery     millivolts             -> battery (V)
//   0x01 led status  bit0 ON/OFF            -> ledStatus (extra)
//   0x00 tamper      (no value)             -> ignored
//
// air.pressure carries a strict atmospheric bound (900-1100 hPa) in the
// vocabulary; a barometric reading outside that band is suppressed rather than
// emitted as air.pressure.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s8(b) {
  return b & 0x80 ? b - 0x100 : b;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 99) {
    return { errors: ['unknown FPort (expected 99 for STEVAL-ASTRA1B)'] };
  }
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short for a STEVAL-ASTRA1B frame'] };
  }

  var data = {};
  var air = {};
  var position = {};
  var recognized = false;

  // bytes[0] is not relevant. Each entry: type at bytes[i], value bytes span
  // bytes[i+1]..bytes[i+len], cursor advances by len+2 (matches upstream).
  var i = 1;
  var len = 0;
  for (i = 1; i < bytes.length; i += len + 2) {
    var type = bytes[i];

    if (type === 0x73) {
      len = 2;
      var hpa = round(((bytes[i + 1] << 8) + bytes[i + len]) / 10, 1);
      // air.pressure is atmospheric only (900-1100 hPa); suppress otherwise.
      if (hpa >= 900 && hpa <= 1100) {
        air.pressure = hpa;
      }
      recognized = true;
    } else if (type === 0x67) {
      len = 2;
      air.temperature = round(((s8(bytes[i + 1]) << 8) + bytes[i + len]) / 10, 1);
      recognized = true;
    } else if (type === 0x68) {
      len = 1;
      air.relativeHumidity = round(bytes[i + len] / 2, 1);
      recognized = true;
    } else if (type === 0x71) {
      len = 6;
      data.accelerationOnX = (s8(bytes[i + 1]) << 8) + bytes[i + 2];
      data.accelerationOnY = (s8(bytes[i + 3]) << 8) + bytes[i + 4];
      data.accelerationOnZ = (s8(bytes[i + 5]) << 8) + bytes[i + len];
      recognized = true;
    } else if (type === 0x88) {
      len = 9;
      var lat = round(
        ((s8(bytes[i + 1]) << 16) + (bytes[i + 2] << 8) + bytes[i + 3]) / 10000,
        6
      );
      var lon = round(
        ((s8(bytes[i + 4]) << 16) + (bytes[i + 5] << 8) + bytes[i + 6]) / 10000,
        6
      );
      if (lat >= -90 && lat <= 90) {
        position.latitude = lat;
      }
      if (lon >= -180 && lon <= 180) {
        position.longitude = lon;
      }
      // Altitude is not modelled by the vocabulary; keep it as a camelCase extra.
      data.altitudeM = round(
        ((s8(bytes[i + 7]) << 16) + (bytes[i + 8] << 8) + bytes[i + len]) / 100,
        2
      );
      recognized = true;
    } else if (type === 0x02) {
      len = 2;
      data.battery = round(((bytes[i + 1] << 8) + bytes[i + len]) / 1000, 3);
      recognized = true;
    } else if (type === 0x01) {
      len = 1;
      data.ledStatus = bytes[i + len] & 0x01 ? 'ON' : 'OFF';
      recognized = true;
    } else if (type === 0x00) {
      // Tamper input carries no value in the upstream frame.
      len = 1;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized STEVAL-ASTRA1B channels'] };
  }

  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.pressure !== undefined
  ) {
    data.air = air;
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "stmicroelectronics";
    result.data.model = "steval-astra1b";
  }
  return result;
}
