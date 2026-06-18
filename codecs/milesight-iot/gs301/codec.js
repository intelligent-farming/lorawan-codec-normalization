// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight GS301 (LoRaWAN Bathroom Odor Detector:
// temperature, humidity, NH3, H2S).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/gs301.js, attributed in NOTICE). Ported faithfully from
// upstream `milesightDeviceDecode`; do NOT copy upstream normalizeUplink.
//
// Mapping decisions:
//   0x01/0x75 battery        byte %                  -> batteryPercent extra
//   0x02/0x67 temperature    int16 LE /10 °C         -> air.temperature
//   0x03/0x68 humidity       byte /2 %               -> air.relativeHumidity
//   0x04/0x7D NH3            uint16 LE /100 ppm      -> air.nh3 extra
//                            0xfffe/0xffff sentinel  -> air.nh3SensorStatus extra
//   0x05/0x7D H2S            uint16 LE /100 ppm      -> air.h2s extra
//                            0xfffe/0xffff sentinel  -> air.h2sSensorStatus extra
//   0x06/0x7D H2S (@v1.2)    uint16 LE /1000 ppm     -> air.h2s extra
//                            0xfffe/0xffff sentinel  -> air.h2sSensorStatus extra
//   0x07/0xEA calibration result, and the version/SN/status/class channels
//             (0xff/...) -> camelCase diagnostic extras at top level.
//
// The vocabulary only models air.co2 for gas; NH3 and H2S concentrations (ppm)
// have no vocabulary key, so they are emitted as the camelCase extras air.nh3 /
// air.h2s (and their *SensorStatus companions). Milesight reports battery as a
// PERCENTAGE; the vocabulary's `battery` is volts, so the percentage is emitted
// as the camelCase extra `batteryPercent` rather than forced into a volts field.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function gsSensorStatus(value) {
  if (value === 0xfffe) {
    return 'polarizing';
  }
  if (value === 0xffff) {
    return 'device error';
  }
  return 'normal';
}

function gsProtocolVersion(b) {
  return 'v' + ((b & 0xf0) >> 4) + '.' + (b & 0x0f);
}

function gsHardwareVersion(lo, hi) {
  return 'v' + (lo & 0xff).toString(16) + '.' + ((hi & 0xff) >> 4);
}

function gsFirmwareVersion(lo, hi) {
  return 'v' + (lo & 0xff).toString(16) + '.' + (hi & 0xff).toString(16);
}

function gsTslVersion(lo, hi) {
  return 'v' + (lo & 0xff) + '.' + (hi & 0xff);
}

function gsSerialNumber(bytes, start) {
  var out = '';
  for (var k = 0; k < 8; k++) {
    out += ('0' + (bytes[start + k] & 0xff).toString(16)).slice(-2);
  }
  return out;
}

function gsAscii(bytes, start, len) {
  var str = '';
  for (var k = 0; k < len; k++) {
    var c = bytes[start + k];
    if (c === 0) {
      break;
    }
    str += String.fromCharCode(c);
  }
  return str;
}

function gsLookup(map, key) {
  var value = map[key];
  return value ? value : 'unknown';
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;
  var recognized = false;

  var lorawanClassMap = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
  var calibrationTypeMap = { 0: 'factory', 1: 'manual' };
  var calibrationResultMap = {
    0: 'success',
    1: 'sensor version not match',
    2: 'i2c communication error'
  };

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0xff && type === 0x01) {
      // IPSO VERSION
      data.ipsoVersion = gsProtocolVersion(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x09) {
      // HARDWARE VERSION
      data.hardwareVersion = gsHardwareVersion(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x0a) {
      // FIRMWARE VERSION
      data.firmwareVersion = gsFirmwareVersion(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x0b) {
      // DEVICE STATUS (upstream always reports "on")
      data.deviceStatus = 'on';
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x0f) {
      // LORAWAN CLASS
      data.lorawanClass = gsLookup(lorawanClassMap, bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x16) {
      // PRODUCT SERIAL NUMBER
      data.sn = gsSerialNumber(bytes, i + 2);
      i += 10;
      recognized = true;
    } else if (channel === 0xff && type === 0xff) {
      // TSL VERSION
      data.tslVersion = gsTslVersion(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x7c) {
      // SENSOR ID (@since v1.2)
      data.sensorId = gsAscii(bytes, i + 2, 43);
      i += 45;
      recognized = true;
    } else if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2] & 0xff;
      i += 3;
      recognized = true;
    } else if (channel === 0x02 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x03 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 % resolution
      air.relativeHumidity = round((bytes[i + 2] & 0xff) / 2, 1);
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x04 && type === 0x7d) {
      // NH3: uint16 LE, 0.01 ppm resolution (0xfffe/0xffff -> sensor status)
      var nh3Raw = u16le(bytes[i + 2], bytes[i + 3]);
      if (nh3Raw === 0xfffe || nh3Raw === 0xffff) {
        air.nh3SensorStatus = gsSensorStatus(nh3Raw);
      } else {
        air.nh3 = round(nh3Raw / 100, 2);
      }
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x05 && type === 0x7d) {
      // H2S: uint16 LE, 0.01 ppm resolution (0xfffe/0xffff -> sensor status)
      var h2sRaw = u16le(bytes[i + 2], bytes[i + 3]);
      if (h2sRaw === 0xfffe || h2sRaw === 0xffff) {
        air.h2sSensorStatus = gsSensorStatus(h2sRaw);
      } else {
        air.h2s = round(h2sRaw / 100, 2);
      }
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x06 && type === 0x7d) {
      // H2S (@since v1.2): uint16 LE, 0.001 ppm resolution
      var h2sRaw2 = u16le(bytes[i + 2], bytes[i + 3]);
      if (h2sRaw2 === 0xfffe || h2sRaw2 === 0xffff) {
        air.h2sSensorStatus = gsSensorStatus(h2sRaw2);
      } else {
        air.h2s = round(h2sRaw2 / 1000, 3);
      }
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x07 && type === 0xea) {
      // SENSOR CALIBRATION RESULT (@since v1.2)
      var sensorId = bytes[i + 2] & 0xff;
      if (sensorId === 0x00) {
        data.nh3CalibrationResult = {
          type: gsLookup(calibrationTypeMap, bytes[i + 3]),
          calibrationValue: round(s16le(bytes[i + 4], bytes[i + 5]) / 100, 2),
          result: gsLookup(calibrationResultMap, bytes[i + 6])
        };
      } else if (sensorId === 0x01) {
        data.h2sCalibrationResult = {
          type: gsLookup(calibrationTypeMap, bytes[i + 3]),
          calibrationValue: round(s16le(bytes[i + 4], bytes[i + 5]) / 1000, 3),
          result: gsLookup(calibrationResultMap, bytes[i + 6])
        };
      }
      i += 7;
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

  return { data: data };
}
