// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Pepperl+Fuchs WILSEN.valve (WS-UCC*), an
// outdoor LoRaWAN valve / cabinet-current monitor that reports valve and sensor
// state, air temperature, battery voltage, optionally a GNSS position fix, and a
// set of device counters / configuration acknowledgements.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/pepperl-fuchs/wilsen.js, codecId
// wilsen-valve-codec, attributed in NOTICE). The upstream TLV field extraction
// is reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream Object.assign output).
//
// Wire format: a flat sequence of TLV records, each
//   [len:1][sensorId:2 (big-endian)][value:(len-2) bytes]
// where `len` is the length of the sensorId + value (i.e. the record occupies
// len+1 bytes total). Records are walked until the payload is exhausted.
// Recognized sensor IDs:
//   0x0201 Temperature       IEEE-754 float32 (BE), degC      -> air.temperature
//   0x5001 GPS latitude      int32 (BE) * 1e-6, deg           -> position.latitude
//   0x5002 GPS longitude     int32 (BE) * 1e-6, deg           -> position.longitude
//   0x5101 Battery           uint8 / 10, volts                -> battery
//   0x0C02 Valve status      uint8, two 4-bit nibbles         -> valve1State / valve2State extras
//   0x0C03 Sensor details    uint16, four 4-bit nibbles       -> sensorNDetails extras
//   0x0C04 Sensor status     uint8, two 4-bit nibbles         -> sensorNStatus extras
//   0x0B01/0B02 Proximity    uint16                           -> proximity / proximityMm extras
//   0x0B06 Filling level     uint8 %                          -> fillingLevel extra
//   0x0B07 Amplitude         uint8                            -> amplitude extra
//   0x0B08 Water body level  uint16 mm                        -> waterBodyLevelMm extra
//   0x2A25 Serial number     ASCII                            -> serialNumber extra
//   0x2A26 Serial (uint)     uint48                           -> serialNumberUint extra
//   0x3101 LoRa tx counter   uint16                           -> loraCount extra
//   0x3102 GPS acq counter   uint16                           -> gpsCount extra
//   0x3103 US meas counter   uint32                           -> usSensorCount extra
//   0x3104 Sensor meas count uint32                           -> sensingCount extra
//
// The GNSS fix (0x5001 / 0x5002) is a genuine on-device position solution, so it
// is published to position.* (qualifying this device as a gps-tracker). Out-of-
// range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding against a
// malformed frame over-reading the packed fields. Downlink-acknowledgement TLVs
// (0xF1xx..0xF8xx) carry configuration echoes, not measurements, and are ignored.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function byte2HexString(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    out = out.concat(('0' + (Number(bytes[i]).toString(16))).slice(-2).toUpperCase());
  }
  return out;
}

function toInt32(value) {
  if (value > 0x7fffffff) {
    return value - 0x100000000;
  }
  return value;
}

function hex2string(hexx) {
  var hex = String(hexx);
  var str = '';
  for (var j = 0; j < hex.length && hex.substr(j, 2) !== '00'; j += 2) {
    str += String.fromCharCode(parseInt(hex.substr(j, 2), 16));
  }
  return str;
}

function decodeFloat32(hexstring) {
  var bytes = [
    parseInt(hexstring.substr(0, 2), 16),
    parseInt(hexstring.substr(2, 2), 16),
    parseInt(hexstring.substr(4, 2), 16),
    parseInt(hexstring.substr(6, 2), 16)
  ];
  var binary = '';
  for (var z = 0; z < bytes.length; z++) {
    var bits = bytes[z].toString(2);
    while (bits.length < 8) {
      bits = '0' + bits;
    }
    binary += bits;
  }
  var sign = binary.charAt(0) === '1' ? -1 : 1;
  var exponent = parseInt(binary.substr(1, 8), 2) - 127;
  var significandBase = binary.substr(9, 23);
  var significandBin = '1' + significandBase;
  if (exponent === -127) {
    if (significandBase.indexOf('1') === -1) {
      return 0;
    }
    exponent = -126;
    significandBin = '0' + significandBase;
  }
  var significand = 0;
  var val = 1;
  for (var cnt = 0; cnt < significandBin.length; cnt++) {
    significand += val * parseInt(significandBin.charAt(cnt), 10);
    val = val / 2;
  }
  return sign * significand * Math.pow(2, exponent);
}

var VALVE_STATUS = {
  0: 'Closed',
  1: 'Open',
  2: 'Undefined',
  3: 'Not connected',
  7: 'Not inquired'
};

var SENSOR_DETAILS = {
  0: 'Low',
  1: 'High',
  7: 'Not inquired',
  8: 'Short circuit',
  9: 'Not connected',
  10: 'Invalid current level'
};

var SENSOR_STATUS = {
  0: 'No target detected',
  1: 'Target detected',
  7: 'Not inquired',
  8: 'Short circuit',
  9: 'Not connected',
  10: 'Invalid current level'
};

function lookup(table, key) {
  return table[key] ? table[key] : 'Invalid';
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['missing payload bytes'] };
  }

  var hexStr = byte2HexString(bytes);
  var data = {};
  var position = {};
  var i;

  for (i = 0; i < hexStr.length; i = i + 0) {
    var len = parseInt(hexStr.substr(i, 2), 16);
    // `len` covers the 2-byte sensorId plus its value; the record is len+1 bytes.
    if (!(len >= 2)) {
      return { errors: ['malformed TLV record (bad length) at byte ' + (i / 2)] };
    }
    if (i + (len + 1) * 2 > hexStr.length) {
      return { errors: ['truncated TLV record at byte ' + (i / 2)] };
    }
    var sID = hexStr.substr(i + 2, 4);
    var v = i + 6;

    if (sID === '0201') {
      data.air = data.air || {};
      data.air.temperature = round(decodeFloat32(hexStr.substr(v, 8)), 1);
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
    } else if (sID === '0C02') {
      var valveStatus = parseInt(hexStr.substr(v, 2), 16);
      data.valve1State = lookup(VALVE_STATUS, valveStatus & 0x0f);
      data.valve2State = lookup(VALVE_STATUS, (valveStatus >> 4) & 0x0f);
    } else if (sID === '0C03') {
      var details = parseInt(hexStr.substr(v, 4), 16);
      data.sensor1Details = lookup(SENSOR_DETAILS, details & 0x000f);
      data.sensor2Details = lookup(SENSOR_DETAILS, (details >> 4) & 0x000f);
      data.sensor3Details = lookup(SENSOR_DETAILS, (details >> 8) & 0x000f);
      data.sensor4Details = lookup(SENSOR_DETAILS, (details >> 12) & 0x000f);
    } else if (sID === '0C04') {
      var status = parseInt(hexStr.substr(v, 2), 16);
      data.sensor1Status = lookup(SENSOR_STATUS, status & 0x0f);
      data.sensor2Status = lookup(SENSOR_STATUS, (status >> 4) & 0x0f);
    } else if (sID === '2A25') {
      data.serialNumber = hex2string(hexStr.substr(v, 28));
    } else if (sID === '2A26') {
      data.serialNumberUint = parseInt(hexStr.substr(v, 12), 16);
    } else if (sID === '3101') {
      data.loraCount = parseInt(hexStr.substr(v, 4), 16);
    } else if (sID === '3102') {
      data.gpsCount = parseInt(hexStr.substr(v, 4), 16);
    } else if (sID === '3103') {
      data.usSensorCount = parseInt(hexStr.substr(v, 8), 16);
    } else if (sID === '3104') {
      data.sensingCount = parseInt(hexStr.substr(v, 8), 16);
    } else if (sID === '5001') {
      var lat = round(toInt32(parseInt(hexStr.substr(v, 8), 16)) / 1000000, 6);
      if (lat >= -90 && lat <= 90) {
        position.latitude = lat;
      }
    } else if (sID === '5002') {
      var lon = round(toInt32(parseInt(hexStr.substr(v, 8), 16)) / 1000000, 6);
      if (lon >= -180 && lon <= 180) {
        position.longitude = lon;
      }
    } else if (sID === '5101') {
      if (parseInt(hexStr.substr(i + 4, 2), 16) === 1) {
        data.battery = round(parseInt(hexStr.substr(v, 2), 16) / 10, 1);
      }
    }
    // Other sensor IDs (downlink-config acknowledgements 0xF1xx..0xF8xx) carry
    // no measurement data and are intentionally skipped.

    i = i + (len + 1) * 2;
  }

  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }

  return { data: data };
}
