// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Pepperl+Fuchs WILSEN.node (WS-UC* family):
// an outdoor, battery-powered multi-sensor LoRaWAN node that reports a GNSS
// position fix together with proximity / sensor status, temperature, and
// battery voltage, plus a large set of downlink-config acknowledgements.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/pepperl-fuchs wilsen-node-codec,
// attributed in NOTICE). The upstream TLV field extraction is reproduced
// faithfully; only the JSON shape is re-authored to the normalized vocabulary
// (never the upstream Object.assign output).
//
// Wire format: a concatenation of TLV blocks. Each block is
//   [len:uint8][sID:uint16][value: (len-2) bytes]
// where `len` counts the sID (2 bytes) plus the value bytes. Sensor IDs of
// interest here:
//   0201  temperature        IEEE-754 float32 (big-endian) °C -> air.temperature
//   5001  GPS latitude        int32 / 1e6 decimal degrees     -> position.latitude
//   5002  GPS longitude       int32 / 1e6 decimal degrees     -> position.longitude
//   5101  battery             uint8 / 10 volts                -> battery (V)
// Proximity / amplitude / sensor-status / counters / serial number and the
// 0xF1xx-0xF8xx downlink-config acknowledgements are surfaced as camelCase
// extras (genuine device data the vocabulary does not model).
//
// Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed frame over-reading the packed fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function toHex(bytes) {
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

function int32(value) {
  if (value > 0x7fffffff) {
    return value - 0x100000000;
  }
  return value;
}

function hexToFloat32(hex) {
  var b0 = parseInt(hex.substr(0, 2), 16);
  var b1 = parseInt(hex.substr(2, 2), 16);
  var b2 = parseInt(hex.substr(4, 2), 16);
  var b3 = parseInt(hex.substr(6, 2), 16);
  var bits = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
  var sign = (bits >>> 31) === 0 ? 1 : -1;
  var exponent = (bits >>> 23) & 0xff;
  var mantissa = bits & 0x7fffff;
  if (exponent === 0) {
    if (mantissa === 0) {
      return 0;
    }
    return sign * mantissa * Math.pow(2, -149);
  }
  if (exponent === 0xff) {
    return mantissa === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + mantissa * Math.pow(2, -23)) * Math.pow(2, exponent - 127);
}

function hexToAscii(hex) {
  var str = '';
  for (var j = 0; j < hex.length && hex.substr(j, 2) !== '00'; j += 2) {
    str += String.fromCharCode(parseInt(hex.substr(j, 2), 16));
  }
  return str;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['missing payload bytes'] };
  }

  var hexStr = toHex(bytes);
  var data = {};
  var warnings = [];
  var air = {};
  var hasAir = false;
  var lat = null;
  var lon = null;

  var i = 0;
  while (i < hexStr.length) {
    var len = parseInt(hexStr.substr(i, 2), 16);
    if (isNaN(len) || len < 2) {
      return { errors: ['malformed TLV block at byte ' + (i / 2)] };
    }
    if (i + (len + 1) * 2 > hexStr.length) {
      return { errors: ['truncated TLV block at byte ' + (i / 2)] };
    }
    var sID = hexStr.substr(i + 2, 4);
    var v = i + 6;

    if (sID === '0201') {
      air.temperature = round(hexToFloat32(hexStr.substr(v, 8)), 1);
      hasAir = true;
    } else if (sID === '0B01') {
      data.proximity = parseInt(hexStr.substr(v, 4), 16);
    } else if (sID === '0B02') {
      data.proximityMm = parseInt(hexStr.substr(v, 4), 16);
    } else if (sID === '0B06') {
      data.fillingLevel = parseInt(hexStr.substr(v, 2), 16);
    } else if (sID === '0B07') {
      data.amplitude = parseInt(hexStr.substr(v, 2), 16);
    } else if (sID === '0B08') {
      data.waterBodyLevelMm = parseInt(hexStr.substr(v, 4), 16);
    } else if (sID === '0C04') {
      var status = parseInt(hexStr.substr(v, 2), 16);
      data.sensor1Detected = (status & 0x0f) === 1;
      data.sensor2Detected = ((status >> 4) & 0x0f) === 1;
    } else if (sID === '2A25') {
      data.serialNumber = hexToAscii(hexStr.substr(v, 28));
    } else if (sID === '2A26') {
      data.serialNumberUint = parseInt(hexStr.substr(v, 12), 16);
    } else if (sID === '3101') {
      data.loraCount = parseInt(hexStr.substr(v, 4), 16);
    } else if (sID === '3102') {
      data.gpsCount = parseInt(hexStr.substr(v, 4), 16);
    } else if (sID === '3103') {
      data.ultrasonicCount = parseInt(hexStr.substr(v, 8), 16);
    } else if (sID === '3104') {
      data.sensingCount = parseInt(hexStr.substr(v, 8), 16);
    } else if (sID === '5001') {
      lat = round(int32(parseInt(hexStr.substr(v, 8), 16)) / 1000000, 6);
    } else if (sID === '5002') {
      lon = round(int32(parseInt(hexStr.substr(v, 8), 16)) / 1000000, 6);
    } else if (sID === '5101') {
      if (parseInt(hexStr.substr(i + 4, 2), 16) === 1) {
        data.battery = round(parseInt(hexStr.substr(v, 2), 16) / 10, 1);
      }
    }

    i += (len + 1) * 2;
  }

  if (hasAir) {
    data.air = air;
  }

  if (lat !== null || lon !== null) {
    var position = {};
    if (lat !== null && lat >= -90 && lat <= 90) {
      position.latitude = lat;
    }
    if (lon !== null && lon >= -180 && lon <= 180) {
      position.longitude = lon;
    }
    if (position.latitude !== undefined || position.longitude !== undefined) {
      data.position = position;
    } else {
      warnings.push('GPS coordinates out of range');
    }
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}
