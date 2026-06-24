// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Comtac LPN TD-1 (LoRaWAN GPS/WiFi asset
// tracker: on-device GNSS position fix, WiFi scan results for assisted
// location, plus ambient temperature and battery voltage).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/comtac/lpn-td1.js, attributed in
// NOTICE). The upstream field extraction (TLV stream on the data port) is
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream output object).
//
// Data port 3 carries a TLV record:
//   data[0]      payload version (must be 0x01)
//   data[1]      packed: posStatus<<5 | pingType<<2 | batFull<<1 | connTest
//   data[2]      battery: (raw*5 + 3000)/1000 V (0xFF = ERROR)
//   data[3]      temperature: signed int8 °C (0x7F = ERROR)
//   data[4..]    TLV records: type 0x01 = GPS (4B lat, 4B lon *1e-6 BE, 1B
//                EPE/SAT), type 0x02 = WiFi (n APs of MAC6 + RSSI1)
// Config port 100 carries device configuration (no position fix).
//
//   gpsLat/gpsLong -> position.latitude / position.longitude (decimal degrees,
//     WGS84), published ONLY when the position status reports a GPS fix and the
//     coordinates are in WGS84 bounds. Out-of-range coordinates (|lat|>90,
//     |lon|>180) are suppressed, guarding against a malformed/over-read frame.
//   temp           -> air.temperature (°C); 'ERROR' sentinel is dropped.
//   batVoltage     -> battery (V); 'ERROR' sentinel is dropped.
//   posStatus, pingType, gpsEPE, gpsSAT, WiFi MAC/RSSI, config fields and
//     status flags -> camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var PAYLOAD_VERSION = 0x01;
var DATA_PORT = 3;
var CONFIG_PORT = 100;
var ERROR_BAT_VOLTAGE = 255;
var ERROR_TEMP = 127;

var POS_STATUS = ['NONE', 'GPS OK', 'GPS NOK', 'WIFI OK', 'WIFI NOK', 'GPS AND WIFI OK', 'GPS AND WIFI NOK'];
var PING_TYPE = ['NORMAL', 'MIDRANGE', 'LONGRANGE', 'EVENT'];

function bin32dec(bin) {
  var num = bin & 0xffffffff;
  if (0x80000000 & num) {
    num = -(0x0100000000 - num);
  }
  return num;
}

function bin8dec(bin) {
  var num = bin & 0xff;
  if (0x80 & num) {
    num = -(0x0100 - num);
  }
  return num;
}

function bin8string(bin) {
  var num = bin & 0xff;
  var str = num.toString(16);
  return str.length === 1 ? '0' + str : str;
}

function decodeData(bytes) {
  if (bytes[0] !== PAYLOAD_VERSION) {
    return { errors: ['Invalid payload version'] };
  }

  var data = {};
  var extras = {};
  var warnings = [];

  var posStatus = (bytes[1] >> 5) & 0x07;
  extras.posStatus = POS_STATUS[posStatus];
  extras.pingType = PING_TYPE[(bytes[1] >> 2) & 0x07];
  if (bytes[1] & 0x02) {
    extras.batteryFull = true;
  }
  if (bytes[1] & 0x01) {
    extras.connectionTest = true;
  }

  if (bytes[2] !== ERROR_BAT_VOLTAGE) {
    data.battery = round((bytes[2] * 5 + 3000) / 1000, 3);
  }

  if (bin8dec(bytes[3]) !== ERROR_TEMP) {
    data.air = { temperature: bin8dec(bytes[3]) };
  }

  var i;
  for (i = 4; i < bytes.length; i++) {
    if (bytes[i] === 0x01) {
      var rawLat = (bytes[i + 1] << 24) | (bytes[i + 2] << 16) | (bytes[i + 3] << 8) | bytes[i + 4];
      var lat = round(bin32dec(rawLat) / 1000000, 6);
      var rawLon = (bytes[i + 5] << 24) | (bytes[i + 6] << 16) | (bytes[i + 7] << 8) | bytes[i + 8];
      var lon = round(bin32dec(rawLon) / 1000000, 6);
      var gpsEPE = (bytes[i + 9] >> 4) & 0x0f;
      var gpsSAT = bytes[i + 9] & 0x0f;

      if (gpsEPE < 0x0f) {
        extras.gpsEpe = gpsEPE * 10 + '-' + (gpsEPE + 1) * 10 + ' meters';
      } else {
        extras.gpsEpe = '> 150 meters';
      }
      extras.gpsSatellites = gpsSAT;

      var latOk = lat >= -90 && lat <= 90;
      var lonOk = lon >= -180 && lon <= 180;
      var position = {};
      if (latOk) {
        position.latitude = lat;
      } else {
        warnings.push('latitude out of range');
      }
      if (lonOk) {
        position.longitude = lon;
      } else {
        warnings.push('longitude out of range');
      }
      if (position.latitude !== undefined || position.longitude !== undefined) {
        data.position = position;
      }
      i += 9;
    } else if (bytes[i] === 0x02) {
      var nrAPs = bytes[i + 1] & 0x0f;
      if (nrAPs < 1 || nrAPs > 4) {
        return { errors: ['Received data corrupted'] };
      }
      var aps = [];
      var j;
      for (j = 0; j < nrAPs; j++) {
        var base = i + 2 + j * 7;
        var mac =
          bin8string(bytes[base]) +
          ':' +
          bin8string(bytes[base + 1]) +
          ':' +
          bin8string(bytes[base + 2]) +
          ':' +
          bin8string(bytes[base + 3]) +
          ':' +
          bin8string(bytes[base + 4]) +
          ':' +
          bin8string(bytes[base + 5]);
        aps.push({ mac: mac, rssi: bytes[base + 6] * -1 });
      }
      extras.wifiAccessPoints = aps;
      i += 1 + nrAPs * 7;
    } else {
      return { errors: ['Received data corrupted'] };
    }
  }

  var key;
  for (key in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, key)) {
      data[key] = extras[key];
    }
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function decodeConfig(bytes) {
  if (bytes[0] !== PAYLOAD_VERSION) {
    return { errors: ['Invalid payload version'] };
  }

  var data = {};
  var extras = {};

  var cfgStatus = '';
  if (bytes[1] & 0x01) {
    cfgStatus += '/CFG INIT';
  }
  if (bytes[1] & 0x02) {
    cfgStatus += '/CFG GET';
  }
  if (bytes[1] & 0x04) {
    cfgStatus += '/CFG SET';
  }
  extras.configStatus = cfgStatus;

  if (bytes[2] !== ERROR_BAT_VOLTAGE) {
    data.battery = round((bytes[2] * 5 + 3000) / 1000, 3);
  }
  if (bin8dec(bytes[3]) !== ERROR_TEMP) {
    data.air = { temperature: bin8dec(bytes[3]) };
  }

  extras.appMainVersion = bytes[4];
  extras.appMinorVersion = bytes[5];
  extras.pingInterval = (bytes[6] << 8) | bytes[7];
  extras.longRangeTrigger = bytes[8];
  extras.midRangeTrigger = bytes[9];
  extras.rejoinTrigger = (bytes[10] << 8) | bytes[11];
  extras.gpsFixes = bytes[12];
  extras.minWifiDetects = bytes[13];

  var key;
  for (key in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, key)) {
      data[key] = extras[key];
    }
  }

  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['missing payload bytes'] };
  }

  if (input.fPort === DATA_PORT) {
    if (bytes.length < 4) {
      return { errors: ['data frame requires at least 4 bytes'] };
    }
    return decodeData(bytes);
  }
  if (input.fPort === CONFIG_PORT) {
    if (bytes.length < 14) {
      return { errors: ['config frame requires 14 bytes'] };
    }
    return decodeConfig(bytes);
  }

  return { errors: ['Invalid FPort'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "comtac";
    result.data.model = "lpn-td1";
  }
  return result;
}
