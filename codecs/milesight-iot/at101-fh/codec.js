// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AT101 (fleet/forklift-harsh variant) —
// asset GPS tracker: GNSS position + Wi-Fi/BLE positioning, temperature,
// battery, and accelerometer-based motion/tilt.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/at101-fh.js, attributed in NOTICE). The TLV walk and
// per-channel field reads below are ported faithfully from that upstream
// decodeUplink; the NORMALIZATION (vocabulary key mapping) is authored here and
// is NOT a copy of upstream normalizeUplink.
//
// Mapping decisions:
//   0x04|0x84 / 0x88 LOCATION  lat/lon int32 LE /1e6  -> position.latitude /
//                                                         position.longitude;
//                              status low nibble       -> motionStatus or
//                                                         tiltStatus extra;
//                              status high nibble       -> geofenceStatus extra;
//                              real motion (start/moving)-> action.motion.detected
//   0x03 / 0x67 TEMPERATURE     int16 LE /10 °C        -> air.temperature
//   0x83 / 0x67 TEMP+ALARM      int16 LE /10 °C        -> air.temperature
//                                                         (+ temperatureAlarm extra)
//   0x01 / 0x75 BATTERY         byte %                 -> batteryPercent extra
//   0x05 / 0x00 DEVICE POSITION byte (0 normal/1 tilt) -> positionType extra
//   0x06 / 0xd9 Wi-Fi SCAN      group/mac/rssi + status-> wifiScan extras
//                                                         (+ motion/tilt status)
//   0x07 / 0x00 TAMPER          byte                   -> tamperStatus extra
//   0x08 / 0x9b ANGLE           6x int8                -> angle extras
//   0xff / *    DEVICE INFO     version/sn/class/etc.  -> camelCase extras
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. GNSS altitude is not modelled by
// the vocabulary. Wi-Fi/BLE scan results, position type, GPS/geofence/motion/
// tilt status, and accelerometer angles have no vocabulary keys and are emitted
// as camelCase extras. Only REAL motion (start/moving) sets
// action.motion.detected; stop/unknown report false.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(b) {
  return b & 0xff;
}

function s8(b) {
  var v = u8(b);
  return v > 0x7f ? v - 0x100 : v;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function s32le(b0, b1, b2, b3) {
  var v = u32le(b0, b1, b2, b3);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

function getValue(map, key) {
  var value = map[key];
  if (!value) {
    value = 'unknown';
  }
  return value;
}

function readProtocolVersion(b) {
  var major = (b & 0xf0) >> 4;
  var minor = b & 0x0f;
  return 'v' + major + '.' + minor;
}

function readHardwareVersion(b0, b1) {
  var major = (b0 & 0xff).toString(16);
  var minor = (b1 & 0xff) >> 4;
  return 'v' + major + '.' + minor;
}

function readFirmwareVersion(b0, b1) {
  var major = (b0 & 0xff).toString(16);
  var minor = (b1 & 0xff).toString(16);
  return 'v' + major + '.' + minor;
}

function readTslVersion(b0, b1) {
  return 'v' + (b0 & 0xff) + '.' + (b1 & 0xff);
}

function readSerialNumber(bytes, start) {
  var temp = [];
  for (var idx = 0; idx < 8; idx++) {
    temp.push(('0' + (bytes[start + idx] & 0xff).toString(16)).slice(-2));
  }
  return temp.join('');
}

function readMAC(bytes, start) {
  var temp = [];
  for (var idx = 0; idx < 6; idx++) {
    temp.push(('0' + (bytes[start + idx] & 0xff).toString(16)).slice(-2));
  }
  return temp.join(':');
}

function readLoRaWANClass(type) {
  return getValue({ 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' }, type);
}

function readMotionStatus(type) {
  return getValue({ 0: 'unknown', 1: 'start', 2: 'moving', 3: 'stop' }, type);
}

function readTiltStatus(type) {
  return getValue({ 4: 'normal', 5: 'tilt' }, type);
}

function readGeofenceStatus(type) {
  return getValue({ 0: 'inside', 1: 'outside', 2: 'unset', 3: 'unknown' }, type);
}

function readDevicePosition(type) {
  return getValue({ 0: 'normal', 1: 'tilt' }, type);
}

function readTamperStatus(type) {
  return getValue({ 0: 'install', 1: 'uninstall' }, type);
}

function readTemperatureAlarm(type) {
  return getValue({ 0: 'normal', 1: 'abnormal' }, type);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var position = {};
  var air = {};
  var motion = {};
  var hasPosition = false;
  var hasAir = false;
  var hasMotion = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];
    var status;
    var statusValue;

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
      data.tslVersion = readTslVersion(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x16) {
      // SERIAL NUMBER
      data.sn = readSerialNumber(bytes, i + 2);
      i += 10;
      recognized = true;
    } else if (channel === 0xff && type === 0x0f) {
      // LORAWAN CLASS TYPE
      data.lorawanClass = readLoRaWANClass(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0xfe) {
      // RESET EVENT
      data.resetEvent = 'reset';
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x0b) {
      // DEVICE STATUS
      data.deviceStatus = 'on';
      i += 3;
      recognized = true;
    } else if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = u8(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x83 && type === 0x67) {
      // TEMPERATURE WITH ABNORMAL
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      air.temperatureAlarm = readTemperatureAlarm(bytes[i + 4]);
      hasAir = true;
      i += 5;
      recognized = true;
    } else if ((channel === 0x04 || channel === 0x84) && type === 0x88) {
      // LOCATION: lat/lon int32 LE /1e6, then status byte
      position.latitude = round(s32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]) / 1000000, 6);
      position.longitude = round(s32le(bytes[i + 6], bytes[i + 7], bytes[i + 8], bytes[i + 9]) / 1000000, 6);
      status = u8(bytes[i + 10]);
      statusValue = status & 0x0f;
      if (statusValue === 0x04 || statusValue === 0x05) {
        data.tiltStatus = readTiltStatus(statusValue);
      } else {
        data.motionStatus = readMotionStatus(statusValue);
        motion.detected = statusValue === 0x01 || statusValue === 0x02;
        hasMotion = true;
      }
      data.geofenceStatus = readGeofenceStatus(status >> 4);
      hasPosition = true;
      i += 11;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // DEVICE POSITION
      data.positionType = readDevicePosition(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0xd9) {
      // Wi-Fi SCAN RESULT
      var wifi = {};
      wifi.group = u8(bytes[i + 2]);
      wifi.mac = readMAC(bytes, i + 3);
      wifi.rssi = s8(bytes[i + 9]);
      status = u8(bytes[i + 10]);
      statusValue = status & 0x0f;
      if (statusValue === 0x04 || statusValue === 0x05) {
        wifi.tiltStatus = readTiltStatus(statusValue);
        data.tiltStatus = wifi.tiltStatus;
      } else {
        wifi.motionStatus = readMotionStatus(statusValue);
        data.motionStatus = wifi.motionStatus;
        motion.detected = statusValue === 0x01 || statusValue === 0x02;
        hasMotion = true;
      }
      i += 11;
      recognized = true;

      data.wifiScanResult = 'finish';
      if (wifi.mac === 'ff:ff:ff:ff:ff:ff') {
        data.wifiScanResult = 'timeout';
        continue;
      }
      data.wifiScan = data.wifiScan || [];
      data.wifiScan.push(wifi);
    } else if (channel === 0x07 && type === 0x00) {
      // TAMPER STATUS
      data.tamperStatus = readTamperStatus(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0x08 && type === 0x9b) {
      // ANGLE
      data.initialAngleX = s8(bytes[i + 2]);
      data.initialAngleY = s8(bytes[i + 3]);
      data.initialAngleZ = s8(bytes[i + 4]);
      data.inclinationAngleX = s8(bytes[i + 5]);
      data.inclinationAngleY = s8(bytes[i + 6]);
      data.inclinationAngleZ = s8(bytes[i + 7]);
      i += 8;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasPosition) {
    data.position = position;
  }
  if (hasAir) {
    data.air = air;
  }
  if (hasMotion) {
    if (!data.action) {
      data.action = {};
    }
    data.action.motion = motion;
  }

  return { data: data };
}
