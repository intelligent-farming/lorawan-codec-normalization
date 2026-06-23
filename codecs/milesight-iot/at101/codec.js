// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AT101 (asset tracker: GNSS positioning,
// Wi-Fi / BLE assisted positioning, temperature, battery, and accelerometer
// motion / tamper status).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/at101.js, in
// turn Milesight-IoT/SensorDecoders at-series/at101, attributed in NOTICE). The
// channel-walk and field extraction are reproduced faithfully; only the JSON
// shape is re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions:
//   0x01/0x75 battery        byte %                     -> batteryPercent extra
//   0x03/0x67 temperature    int16 LE /10 °C            -> air.temperature
//   0x83/0x67 temperature+   int16 LE /10 °C + alarm    -> air.temperature
//                                                          (+ temperatureAlarm extra)
//   0x04|0x84 /0x88 location int32 LE /1e6 lat & lon    -> position.latitude /
//                            + status nibbles              position.longitude
//                                                          (+ motionStatus,
//                                                           geofenceStatus extras;
//                                                           action.motion.detected
//                                                           when a real moving state)
//   0x05/0x00 device pos     byte (normal/tilt)         -> devicePosition extra
//   0x06/0xD9 Wi-Fi scan     group/mac/rssi/motion      -> wifiScan[] extra
//                                                          (+ wifiScanResult,
//                                                           action.motion.detected)
//   0x07/0x00 tamper status  byte (install/uninstall)   -> tamperStatus extra
//   0x20/0xCE historical loc timestamp + lon/lat        -> locationHistory[] extra
//   0xFF/...  device info    versions / sn / class etc. -> camelCase extras
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`.
// GNSS latitude/longitude map to position.latitude/longitude. Motion is only
// asserted (action.motion.detected) when the device reports a genuine moving
// state ("start"/"moving" => true, "stop" => false); "unknown" yields no motion
// object. The Wi-Fi/BLE scan list, positioning status, device tilt and tamper
// state have no vocabulary key and are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32le(b0, b1, b2, b3) {
  var v = (b3 << 24) + (b2 << 16) + (b1 << 8) + b0;
  return v >>> 0;
}

function s32le(b0, b1, b2, b3) {
  var v = u32le(b0, b1, b2, b3);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function hex2(b) {
  var s = (b & 0xff).toString(16);
  return s.length < 2 ? '0' + s : s;
}

function readMotionStatus(t) {
  var m = { 0: 'unknown', 1: 'start', 2: 'moving', 3: 'stop' };
  return m[t] !== undefined ? m[t] : 'unknown';
}

function readGeofenceStatus(t) {
  var m = { 0: 'inside', 1: 'outside', 2: 'unset', 3: 'unknown' };
  return m[t] !== undefined ? m[t] : 'unknown';
}

function readDevicePosition(t) {
  var m = { 0: 'normal', 1: 'tilt' };
  return m[t] !== undefined ? m[t] : 'unknown';
}

function readTamperStatus(t) {
  var m = { 0: 'install', 1: 'uninstall' };
  return m[t] !== undefined ? m[t] : 'unknown';
}

function readProtocolVersion(b) {
  return 'v' + ((b & 0xf0) >> 4) + '.' + (b & 0x0f);
}

function readHardwareVersion(b0, b1) {
  return 'v' + (b0 & 0xff).toString(16) + '.' + ((b1 & 0xff) >> 4);
}

function readFirmwareVersion(b0, b1) {
  return 'v' + (b0 & 0xff).toString(16) + '.' + (b1 & 0xff).toString(16);
}

function readSerialNumber(bytes, start) {
  var s = '';
  for (var k = 0; k < 8; k++) {
    s += hex2(bytes[start + k]);
  }
  return s;
}

function readLoRaWANClass(t) {
  var m = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
  return m[t] !== undefined ? m[t] : 'unknown';
}

// A genuine moving state asserts motion; "stop" clears it; "unknown" is no signal.
function motionFromStatus(status) {
  if (status === 'start' || status === 'moving') {
    return true;
  }
  if (status === 'stop') {
    return false;
  }
  return null;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;
  var motionDetected = null;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0xff && type === 0x01) {
      // IPSO VERSION
      data.ipsoVersion = readProtocolVersion(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x09) {
      // HARDWARE VERSION
      data.hardwareVersion = readHardwareVersion(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x0a) {
      // FIRMWARE VERSION
      data.firmwareVersion = readFirmwareVersion(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0xff) {
      // TSL VERSION
      data.tslVersion = 'v' + (bytes[i + 2] & 0xff) + '.' + (bytes[i + 3] & 0xff);
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x16) {
      // SERIAL NUMBER (8 bytes)
      data.sn = readSerialNumber(bytes, i + 2);
      i += 10;
      recognized = true;
    } else if (channel === 0xff && type === 0x0f) {
      // LORAWAN CLASS
      data.lorawanClass = readLoRaWANClass(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0xfe) {
      // RESET EVENT (1-byte fixed status)
      data.resetEvent = 'reset';
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x0b) {
      // DEVICE STATUS (power-on)
      data.deviceStatus = 'on';
      i += 3;
      recognized = true;
    } else if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2] & 0xff;
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x83 && type === 0x67) {
      // TEMPERATURE WITH ABNORMAL: int16 LE /10 °C + alarm byte
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      data.temperatureAlarm = bytes[i + 4] === 1 ? 'abnormal' : 'normal';
      hasAir = true;
      i += 5;
      recognized = true;
    } else if ((channel === 0x04 || channel === 0x84) && type === 0x88) {
      // LOCATION: int32 LE lat & lon (/1e6) + status nibbles
      var lat = round(s32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]) / 1000000, 6);
      var lon = round(s32le(bytes[i + 6], bytes[i + 7], bytes[i + 8], bytes[i + 9]) / 1000000, 6);
      var status = bytes[i + 10];
      var mStatus = readMotionStatus(status & 0x0f);
      data.motionStatus = mStatus;
      data.geofenceStatus = readGeofenceStatus(status >> 4);
      var position = {};
      // Suppress out-of-range fixes (guards against a bad GNSS frame).
      if (lat >= -90 && lat <= 90) {
        position.latitude = lat;
      }
      if (lon >= -180 && lon <= 180) {
        position.longitude = lon;
      }
      if (position.latitude !== undefined || position.longitude !== undefined) {
        data.position = position;
      }
      var m = motionFromStatus(mStatus);
      if (m !== null) {
        motionDetected = m;
      }
      i += 11;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // DEVICE POSITION (tilt)
      data.devicePosition = readDevicePosition(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0xd9) {
      // Wi-Fi SCAN RESULT entry: group, MAC(6), rssi, motion-status byte
      var mac = '';
      for (var k = 0; k < 6; k++) {
        mac += (k > 0 ? ':' : '') + hex2(bytes[i + 3 + k]);
      }
      var rawRssi = bytes[i + 9] & 0xff;
      var entry = {
        group: bytes[i + 2] & 0xff,
        mac: mac,
        rssi: rawRssi > 0x7f ? rawRssi - 0x100 : rawRssi
      };
      var wifiMotion = readMotionStatus(bytes[i + 10] & 0x0f);
      entry.motionStatus = wifiMotion;
      i += 11;
      recognized = true;
      if (mac === 'ff:ff:ff:ff:ff:ff') {
        // Sentinel MAC => scan timed out without a usable AP.
        data.wifiScanResult = 'timeout';
      } else {
        data.wifiScanResult = 'finish';
        var m2 = motionFromStatus(wifiMotion);
        if (m2 !== null) {
          motionDetected = m2;
        }
        if (!data.wifiScan) {
          data.wifiScan = [];
        }
        data.wifiScan.push(entry);
      }
    } else if (channel === 0x07 && type === 0x00) {
      // TAMPER STATUS
      data.tamperStatus = readTamperStatus(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      // HISTORICAL LOCATION: timestamp(u32) + lon(i32) + lat(i32), all /1e6
      var ts = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      var hLon = round(s32le(bytes[i + 6], bytes[i + 7], bytes[i + 8], bytes[i + 9]) / 1000000, 6);
      var hLat = round(s32le(bytes[i + 10], bytes[i + 11], bytes[i + 12], bytes[i + 13]) / 1000000, 6);
      if (!data.locationHistory) {
        data.locationHistory = [];
      }
      data.locationHistory.push({ timestamp: ts, latitude: hLat, longitude: hLon });
      i += 14;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasAir) {
    data.air = air;
  }
  if (motionDetected !== null) {
    data.action = { motion: { detected: motionDetected } };
  }

  return { data: data };
}
