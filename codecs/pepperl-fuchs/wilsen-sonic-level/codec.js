// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Pepperl+Fuchs WILSEN.sonic.level (WS-UC*) — a
// battery-powered outdoor ultrasonic fill-level / distance sensor that also
// carries a GNSS receiver and reports its on-device GPS position fix.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (a TLV stream of 1-byte length + 2-byte sensor-ID + value records) was
// ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/pepperl-fuchs/wilsen.js, attributed
// in NOTICE). The upstream field extraction (hex-string substring slicing and
// the IEEE-754 float decode) is reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream payloadParser
// output object).
//
// TLV record layout, walked over the uplink hex string:
//   [len:1 byte][sID:2 bytes][value:len-2 bytes]; advance by (len + 1) bytes.
// Decoded sensor IDs (measurement-bearing only):
//   0201 Temperature        IEEE-754 float32, °C        -> air.temperature
//   0B01 Proximity          uint16, cm                  -> distanceCm (extra)
//   0B02 Proximity (mm)     uint16, mm                  -> distanceMm (extra)
//   0B06 Filling level      uint8, %                    -> fillLevelPercent (extra)
//   0B07 Amplitude          uint8                       -> amplitude (extra)
//   0B08 Water body level   uint16, mm                  -> waterBodyLevelMm (extra)
//   2A25 Serial number      ASCII string                -> serialNumber (extra)
//   3101 LoRa tx counter    uint16                      -> loraCount (extra)
//   3102 GPS acq counter    uint16                      -> gpsCount (extra)
//   3103 US meas counter    uint32                      -> usMeasurementCount (extra)
//   3104 Sensor meas count  uint32                      -> sensingCount (extra)
//   5001 GPS latitude       int32 * 1e-6, deg           -> position.latitude
//   5002 GPS longitude      int32 * 1e-6, deg           -> position.longitude
//   5101 Battery            uint8 / 10, V               -> battery
// Configuration / downlink-ack records (0xF1xx..0xF8xx) are device settings, not
// measurements, and are ignored. GPS coordinates outside the valid range
// (|lat| > 90, |lon| > 180) are suppressed, guarding against a malformed record
// over-reading the packed field.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    if (h.length < 2) {
      h = '0' + h;
    }
    s += h.toUpperCase();
  }
  return s;
}

function toInt32(value) {
  if (value > 0x7fffffff) {
    return value - 0x100000000;
  }
  return value;
}

// Decode a big-endian IEEE-754 single-precision float from 8 hex chars.
function hexToFloat32(hex) {
  var b0 = parseInt(hex.substr(0, 2), 16);
  var b1 = parseInt(hex.substr(2, 2), 16);
  var b2 = parseInt(hex.substr(4, 2), 16);
  var b3 = parseInt(hex.substr(6, 2), 16);
  var bits = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;

  var sign = (bits >>> 31) === 0 ? 1 : -1;
  var exponent = (bits >>> 23) & 0xff;
  var fraction = bits & 0x7fffff;

  if (exponent === 0) {
    if (fraction === 0) {
      return 0;
    }
    return sign * fraction * Math.pow(2, -149);
  }
  if (exponent === 0xff) {
    // Inf / NaN — return 0 so a corrupt record cannot poison the output.
    return 0;
  }
  return sign * (1 + fraction * Math.pow(2, -23)) * Math.pow(2, exponent - 127);
}

// ASCII text field; stops at the first NUL byte (upstream behaviour).
function hexToString(hex) {
  var str = '';
  for (var j = 0; j < hex.length && hex.substr(j, 2) !== '00'; j += 2) {
    str += String.fromCharCode(parseInt(hex.substr(j, 2), 16));
  }
  return str;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short for a WILSEN.sonic.level frame'] };
  }

  var hex = bytesToHex(bytes);
  var data = {};
  var air = {};
  var position = {};
  var decodedAny = false;

  var i = 0;
  while (i + 6 <= hex.length) {
    var len = parseInt(hex.substr(i, 2), 16);
    var sID = hex.substr(i + 2, 4);
    var v = i + 6;

    if (sID === '0201') {
      // Temperature: IEEE-754 float32, degrees Celsius.
      air.temperature = round(hexToFloat32(hex.substr(v, 8)), 1);
      decodedAny = true;
    } else if (sID === '0B01') {
      data.distanceCm = parseInt(hex.substr(v, 4), 16);
      decodedAny = true;
    } else if (sID === '0B02') {
      data.distanceMm = parseInt(hex.substr(v, 4), 16);
      decodedAny = true;
    } else if (sID === '0B06') {
      data.fillLevelPercent = parseInt(hex.substr(v, 2), 16);
      decodedAny = true;
    } else if (sID === '0B07') {
      data.amplitude = parseInt(hex.substr(v, 2), 16);
      decodedAny = true;
    } else if (sID === '0B08') {
      data.waterBodyLevelMm = parseInt(hex.substr(v, 4), 16);
      decodedAny = true;
    } else if (sID === '2A25') {
      data.serialNumber = hexToString(hex.substr(v, 28));
      decodedAny = true;
    } else if (sID === '3101') {
      data.loraCount = parseInt(hex.substr(v, 4), 16);
      decodedAny = true;
    } else if (sID === '3102') {
      data.gpsCount = parseInt(hex.substr(v, 4), 16);
      decodedAny = true;
    } else if (sID === '3103') {
      data.usMeasurementCount = parseInt(hex.substr(v, 8), 16);
      decodedAny = true;
    } else if (sID === '3104') {
      data.sensingCount = parseInt(hex.substr(v, 8), 16);
      decodedAny = true;
    } else if (sID === '5001') {
      var lat = round(toInt32(parseInt(hex.substr(v, 8), 16)) / 1000000, 6);
      if (lat >= -90 && lat <= 90) {
        position.latitude = lat;
      }
      decodedAny = true;
    } else if (sID === '5002') {
      var lon = round(toInt32(parseInt(hex.substr(v, 8), 16)) / 1000000, 6);
      if (lon >= -180 && lon <= 180) {
        position.longitude = lon;
      }
      decodedAny = true;
    } else if (sID === '5101') {
      // Battery: uint8 in 0.1 V steps.
      data.battery = round(parseInt(hex.substr(v, 2), 16) / 10, 1);
      decodedAny = true;
    }
    // All other sIDs (0xF1xx..0xF8xx config / downlink-ack records) are
    // device settings, not measurements — skipped.

    i = i + (len + 1) * 2;
  }

  if (!decodedAny) {
    return { errors: ['no recognized sensor records in frame'] };
  }

  if (air.temperature !== undefined) {
    data.air = air;
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }

  return { data: data };
}
