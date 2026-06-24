// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight GS601 (LoRaWAN Vape Detector). Despite
// the "gas/odour" framing, the upstream TTN device is an indoor vape/air-quality
// detector: vaping index, PM1.0/PM2.5/PM10, temperature, humidity, TVOC, plus
// tamper / buzzer / occupancy status and a large set of attribute/config/service
// frames.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight command-id TLV stream) ported faithfully from the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/
// gs601.js, attributed in NOTICE). The byte-walk, command ids, alarm-frame
// shapes, enum maps and float/int readers mirror upstream exactly; only the
// OUTPUT is re-shaped into the normalized vocabulary. Upstream emits a raw flat
// object (no normalizeUplink); we author the normalization here.
//
// Mapping decisions:
//   0x00 battery        uint8 %             -> batteryPercent extra
//   0x09 temperature    int16 LE /10 °C     -> air.temperature
//   0x0a temp alarm     (incl. value frame) -> air.temperature (+ air.temperatureAlarm)
//   0x0b humidity       uint16 LE /10 %     -> air.relativeHumidity
//   0x0c humidity alarm                     -> air.humidityAlarm extra
//   0x01 vaping index   uint8               -> air.vapingIndex extra
//   0x02 vaping alarm   (incl. value frame) -> air.vapingIndex (+ air.vapingIndexAlarm)
//   0x03 PM1.0          uint16 LE µg/m³     -> air.pm1 extra
//   0x05 PM2.5          uint16 LE µg/m³     -> air.pm25 extra
//   0x07 PM10           uint16 LE µg/m³     -> air.pm10 extra
//   0x04/0x06/0x08 PM alarms                -> air.pm{1,25,10}Alarm extras
//   0x0d TVOC           uint16 LE           -> air.tvoc extra
//   0x0e TVOC alarm     (incl. value frame) -> air.tvoc (+ air.tvocAlarm)
//   0x0f tamper status                      -> tamperStatus extra
//   0x10 tamper alarm                       -> tamperStatusAlarm extra
//   0x11 buzzer status                      -> buzzer extra
//   0x12 occupancy status                   -> occupancyStatus extra
//   0x20-0x2a TVOC raw                      -> tvocRawData{1..11} extras
//   0x2b PM sensor working time             -> pmSensorWorkingTime extra
//   attribute / config / service / control frames -> camelCase extras
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`.
// Temperature & humidity map to the vocabulary keys air.temperature /
// air.relativeHumidity. The vocabulary models neither vaping index, PM, TVOC
// nor the various status/alarm flags, so all of those are camelCase extras
// (placed under `air` for the air-quality measurements, top-level for device
// status). PM names use camelCase `pm1`/`pm25`/`pm10` (upstream `pm1_0`/`pm2_5`).
// An unknown command id aborts the walk and returns an error, mirroring the
// upstream throw.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function readUInt8(b) {
  return b & 0xff;
}

function readInt8(b) {
  var ref = readUInt8(b);
  return ref > 0x7f ? ref - 0x100 : ref;
}

function readUInt16LE(bytes) {
  var value = (bytes[1] << 8) + bytes[0];
  return value & 0xffff;
}

function readInt16LE(bytes) {
  var ref = readUInt16LE(bytes);
  return ref > 0x7fff ? ref - 0x10000 : ref;
}

function readUInt32LE(bytes) {
  var value = (bytes[3] << 24) + (bytes[2] << 16) + (bytes[1] << 8) + bytes[0];
  return (value & 0xffffffff) >>> 0;
}

function readFloatLE(bytes) {
  var bits = (bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0];
  var sign = bits >>> 31 === 0 ? 1.0 : -1.0;
  var e = (bits >>> 23) & 0xff;
  var m = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  var f = sign * m * Math.pow(2, e - 150);
  return Number(f.toFixed(3));
}

function readString(bytes) {
  var str = '';
  var i = 0;
  var byte1, byte2, byte3, byte4;
  while (i < bytes.length) {
    byte1 = bytes[i++];
    if (byte1 <= 0x7f) {
      str += String.fromCharCode(byte1);
    } else if (byte1 <= 0xdf) {
      byte2 = bytes[i++];
      str += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f));
    } else if (byte1 <= 0xef) {
      byte2 = bytes[i++];
      byte3 = bytes[i++];
      str += String.fromCharCode(((byte1 & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f));
    } else if (byte1 <= 0xf7) {
      byte2 = bytes[i++];
      byte3 = bytes[i++];
      byte4 = bytes[i++];
      var codepoint = ((byte1 & 0x07) << 18) | ((byte2 & 0x3f) << 12) | ((byte3 & 0x3f) << 6) | (byte4 & 0x3f);
      codepoint -= 0x10000;
      str += String.fromCharCode((codepoint >> 10) + 0xd800);
      str += String.fromCharCode((codepoint & 0x3ff) + 0xdc00);
    }
  }
  return str;
}

function readHexString(bytes) {
  var temp = [];
  for (var idx = 0; idx < bytes.length; idx++) {
    temp.push(('0' + (bytes[idx] & 0xff).toString(16)).slice(-2));
  }
  return temp.join('');
}

function slice(bytes, start, end) {
  var out = [];
  for (var k = start; k < end && k < bytes.length; k++) {
    out.push(bytes[k]);
  }
  return out;
}

function getValue(map, key) {
  var value = map[key];
  if (!value) value = 'unknown';
  return value;
}

function readProtocolVersion(bytes) {
  return 'v' + (bytes[0] & 0xff) + '.' + (bytes[1] & 0xff);
}

function readHardwareVersion(bytes) {
  return 'v' + (bytes[0] & 0xff) + '.' + (bytes[1] & 0xff);
}

function readFirmwareVersion(bytes) {
  var major = bytes[0] & 0xff;
  var minor = bytes[1] & 0xff;
  var release = bytes[2] & 0xff;
  var alpha = bytes[3] & 0xff;
  var unitTest = bytes[4] & 0xff;
  var test = bytes[5] & 0xff;
  var version = 'v' + major + '.' + minor;
  if (release !== 0) version += '-r' + release;
  if (alpha !== 0) version += '-a' + alpha;
  if (unitTest !== 0) version += '-u' + unitTest;
  if (test !== 0) version += '-t' + test;
  return version;
}

function readDeviceStatus(type) {
  return getValue({ 0: 'off', 1: 'on' }, type);
}

function readLoRaWANClass(type) {
  return getValue({ 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' }, type);
}

function readVapeIndexAlarmType(type) {
  return getValue(
    {
      0: 'collection error',
      1: 'lower range error',
      2: 'over range error',
      16: 'alarm deactivation',
      17: 'alarm trigger',
      32: 'interference alarm deactivation',
      33: 'interference alarm trigger'
    },
    type
  );
}

function readPMAlarmType(type) {
  return getValue(
    {
      0: 'collection error',
      1: 'lower range error',
      2: 'over range error',
      16: 'alarm deactivation',
      17: 'alarm trigger'
    },
    type
  );
}

function readTemperatureAlarmType(type) {
  return getValue(
    {
      0: 'collection error',
      1: 'lower range error',
      2: 'over range error',
      16: 'alarm deactivation',
      17: 'alarm trigger',
      32: 'burning alarm deactivation',
      33: 'burning alarm trigger'
    },
    type
  );
}

function readHumidityAlarmType(type) {
  return getValue({ 0: 'collection error', 1: 'lower range error', 2: 'over range error' }, type);
}

function readTVOCAlarmType(type) {
  return getValue(
    {
      0: 'collection error',
      1: 'lower range error',
      2: 'over range error',
      16: 'alarm deactivation',
      17: 'alarm trigger'
    },
    type
  );
}

function readTamperStatus(type) {
  return getValue({ 0: 'normal', 1: 'triggered' }, type);
}

function readTamperAlarmType(type) {
  return getValue({ 32: 'alarm deactivation', 33: 'alarm trigger' }, type);
}

function readBuzzerStatus(type) {
  return getValue({ 0: 'normal', 1: 'triggered' }, type);
}

function readOccupancyStatus(type) {
  return getValue({ 0: 'vacant', 1: 'occupied' }, type);
}

function readTimeUnitType(type) {
  return getValue({ 0: 'second', 1: 'minute' }, type);
}

function readTemperatureType(type) {
  return getValue({ 0: 'celsius', 1: 'fahrenheit' }, type);
}

function readEnableStatus(status) {
  return getValue({ 0: 'disable', 1: 'enable' }, status);
}

function readYesNoStatus(type) {
  return getValue({ 0: 'no', 1: 'yes' }, type);
}

function readThresholdCondition(type) {
  return getValue({ 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' }, type);
}

function readTimeZone(timeZone) {
  var map = {
    '-720': 'UTC-12', '-660': 'UTC-11', '-600': 'UTC-10', '-570': 'UTC-9:30',
    '-540': 'UTC-9', '-480': 'UTC-8', '-420': 'UTC-7', '-360': 'UTC-6',
    '-300': 'UTC-5', '-240': 'UTC-4', '-210': 'UTC-3:30', '-180': 'UTC-3',
    '-120': 'UTC-2', '-60': 'UTC-1', 0: 'UTC', 60: 'UTC+1', 120: 'UTC+2',
    180: 'UTC+3', 210: 'UTC+3:30', 240: 'UTC+4', 270: 'UTC+4:30', 300: 'UTC+5',
    330: 'UTC+5:30', 345: 'UTC+5:45', 360: 'UTC+6', 390: 'UTC+6:30', 420: 'UTC+7',
    480: 'UTC+8', 540: 'UTC+9', 570: 'UTC+9:30', 600: 'UTC+10', 630: 'UTC+10:30',
    660: 'UTC+11', 720: 'UTC+12', 765: 'UTC+12:45', 780: 'UTC+13', 840: 'UTC+14'
  };
  return getValue(map, timeZone);
}

function readCmdResult(type) {
  return getValue(
    {
      0: 'success', 1: 'parsing error', 2: 'order error', 3: 'password error',
      4: 'read params error', 5: 'write params error', 6: 'read execution error',
      7: 'write execution error', 8: 'read apply error', 9: 'write apply error',
      10: 'associative error'
    },
    type
  );
}

function readCmdName(type) {
  var nameMap = {
    60: 'reporting_interval', 61: 'temperature_unit', 62: 'led_status',
    63: 'buzzer_enable', 64: 'buzzer_sleep', 65: 'buzzer_button_stop_enable',
    66: 'buzzer_silent_time', 67: 'tamper_alarm_enable', 68: 'tvoc_raw_reporting_enable',
    69: 'temperature_alarm_settings', '6a': 'pm1_0_alarm_settings', '6b': 'pm2_5_alarm_settings',
    '6c': 'pm10_alarm_settings', '6d': 'tvoc_alarm_settings', '6e': 'vaping_index_alarm_settings',
    '6f': 'alarm_reporting_times', 70: 'alarm_deactivation_enable', 71: 'temperature_calibration_settings',
    72: 'humidity_calibration_settings', 73: 'pm1_0_calibration_settings', 74: 'pm2_5_calibration_settings',
    75: 'pm10_calibration_settings', 76: 'tvoc_calibration_settings', 77: 'vaping_index_calibration_settings',
    c6: 'daylight_saving_time', c7: 'time_zone', be: 'reboot', b6: 'reconnect',
    b8: 'synchronize_time', b9: 'query_device_status', '5f': 'stop_buzzer_alarm',
    '5e': 'execute_tvoc_self_clean'
  };
  var data = nameMap[type];
  if (data === undefined) return 'unknown';
  return data;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;

  var i = 0;
  while (i < bytes.length) {
    var commandId = bytes[i++];
    var alarmType;

    if (commandId === 0xdf) {
      data.tslVersion = readProtocolVersion(slice(bytes, i, i + 2));
      i += 2;
    } else if (commandId === 0xde) {
      data.productName = readString(slice(bytes, i, i + 32));
      i += 32;
    } else if (commandId === 0xdd) {
      data.productPn = readString(slice(bytes, i, i + 32));
      i += 32;
    } else if (commandId === 0xdb) {
      data.productSn = readHexString(slice(bytes, i, i + 8));
      i += 8;
    } else if (commandId === 0xda) {
      data.version = {};
      data.version.hardwareVersion = readHardwareVersion(slice(bytes, i, i + 2));
      data.version.firmwareVersion = readFirmwareVersion(slice(bytes, i + 2, i + 8));
      i += 8;
    } else if (commandId === 0xd9) {
      data.oemId = readHexString(slice(bytes, i, i + 2));
      i += 2;
    } else if (commandId === 0xd8) {
      data.productFrequencyBand = readString(slice(bytes, i, i + 16));
      i += 16;
    } else if (commandId === 0xee) {
      data.deviceRequest = 1;
      i += 0;
    } else if (commandId === 0xc8) {
      data.deviceStatus = readDeviceStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0xcf) {
      data.lorawanClass = readLoRaWANClass(bytes[i + 1]);
      i += 2;

    // telemetry
    } else if (commandId === 0x00) {
      data.batteryPercent = readUInt8(bytes[i]);
      i += 1;
    } else if (commandId === 0x01) {
      air.vapingIndex = readUInt8(bytes[i]);
      hasAir = true;
      i += 1;
    } else if (commandId === 0x02) {
      var vapingIndexAlarm = {};
      alarmType = bytes[i];
      vapingIndexAlarm.type = readVapeIndexAlarmType(alarmType);
      if (alarmType === 0x10 || alarmType === 0x11) {
        vapingIndexAlarm.vapingIndex = readUInt8(bytes[i + 1]);
        air.vapingIndex = readUInt8(bytes[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
      air.vapingIndexAlarm = vapingIndexAlarm;
      hasAir = true;
    } else if (commandId === 0x03) {
      air.pm1 = readUInt16LE(slice(bytes, i, i + 2));
      hasAir = true;
      i += 2;
    } else if (commandId === 0x04) {
      var pm1Alarm = {};
      alarmType = bytes[i];
      pm1Alarm.type = readPMAlarmType(alarmType);
      if (alarmType === 0x10 || alarmType === 0x11) {
        pm1Alarm.pm1 = readUInt16LE(slice(bytes, i + 1, i + 3));
        air.pm1 = readUInt16LE(slice(bytes, i + 1, i + 3));
        i += 3;
      } else {
        i += 1;
      }
      air.pm1Alarm = pm1Alarm;
      hasAir = true;
    } else if (commandId === 0x05) {
      air.pm25 = readUInt16LE(slice(bytes, i, i + 2));
      hasAir = true;
      i += 2;
    } else if (commandId === 0x06) {
      var pm25Alarm = {};
      alarmType = bytes[i];
      pm25Alarm.type = readPMAlarmType(alarmType);
      if (alarmType === 0x10 || alarmType === 0x11) {
        pm25Alarm.pm25 = readUInt16LE(slice(bytes, i + 1, i + 3));
        air.pm25 = readUInt16LE(slice(bytes, i + 1, i + 3));
        i += 3;
      } else {
        i += 1;
      }
      air.pm25Alarm = pm25Alarm;
      hasAir = true;
    } else if (commandId === 0x07) {
      air.pm10 = readUInt16LE(slice(bytes, i, i + 2));
      hasAir = true;
      i += 2;
    } else if (commandId === 0x08) {
      var pm10Alarm = {};
      alarmType = bytes[i];
      pm10Alarm.type = readPMAlarmType(alarmType);
      if (alarmType === 0x10 || alarmType === 0x11) {
        pm10Alarm.pm10 = readUInt16LE(slice(bytes, i + 1, i + 3));
        air.pm10 = readUInt16LE(slice(bytes, i + 1, i + 3));
        i += 3;
      } else {
        i += 1;
      }
      air.pm10Alarm = pm10Alarm;
      hasAir = true;
    } else if (commandId === 0x09) {
      air.temperature = round(readInt16LE(slice(bytes, i, i + 2)) / 10, 1);
      hasAir = true;
      i += 2;
    } else if (commandId === 0x0a) {
      var temperatureAlarm = {};
      alarmType = bytes[i];
      temperatureAlarm.type = readTemperatureAlarmType(alarmType);
      if (alarmType === 0x10 || alarmType === 0x11) {
        temperatureAlarm.temperature = round(readInt16LE(slice(bytes, i + 1, i + 3)) / 10, 1);
        air.temperature = round(readInt16LE(slice(bytes, i + 1, i + 3)) / 10, 1);
        i += 3;
      } else {
        i += 1;
      }
      air.temperatureAlarm = temperatureAlarm;
      hasAir = true;
    } else if (commandId === 0x0b) {
      air.relativeHumidity = round(readUInt16LE(slice(bytes, i, i + 2)) / 10, 1);
      hasAir = true;
      i += 2;
    } else if (commandId === 0x0c) {
      var humidityAlarm = {};
      humidityAlarm.type = readHumidityAlarmType(bytes[i]);
      i += 1;
      air.humidityAlarm = humidityAlarm;
      hasAir = true;
    } else if (commandId === 0x0d) {
      air.tvoc = readUInt16LE(slice(bytes, i, i + 2));
      hasAir = true;
      i += 2;
    } else if (commandId === 0x0e) {
      var tvocAlarm = {};
      alarmType = bytes[i];
      tvocAlarm.type = readTVOCAlarmType(alarmType);
      if (alarmType === 0x10 || alarmType === 0x11) {
        tvocAlarm.tvoc = readUInt16LE(slice(bytes, i + 1, i + 3));
        air.tvoc = readUInt16LE(slice(bytes, i + 1, i + 3));
        i += 3;
      } else {
        i += 1;
      }
      air.tvocAlarm = tvocAlarm;
      hasAir = true;
    } else if (commandId === 0x0f) {
      data.tamperStatus = readTamperStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x10) {
      var tamperStatusAlarm = {};
      tamperStatusAlarm.type = readTamperAlarmType(bytes[i]);
      i += 1;
      data.tamperStatusAlarm = tamperStatusAlarm;
    } else if (commandId === 0x11) {
      data.buzzer = readBuzzerStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x12) {
      data.occupancyStatus = readOccupancyStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x20) {
      data.tvocRawData1 = { rmox0: readFloatLE(slice(bytes, i, i + 4)), rmox1: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x21) {
      data.tvocRawData2 = { rmox2: readFloatLE(slice(bytes, i, i + 4)), rmox3: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x22) {
      data.tvocRawData3 = { rmox4: readFloatLE(slice(bytes, i, i + 4)), rmox5: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x23) {
      data.tvocRawData4 = { rmox6: readFloatLE(slice(bytes, i, i + 4)), rmox7: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x24) {
      data.tvocRawData5 = { rmox8: readFloatLE(slice(bytes, i, i + 4)), rmox9: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x25) {
      data.tvocRawData6 = { rmox10: readFloatLE(slice(bytes, i, i + 4)), rmox11: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x26) {
      data.tvocRawData7 = { rmox12: readFloatLE(slice(bytes, i, i + 4)), zmod4510Rmox3: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x27) {
      data.tvocRawData8 = { logRcda: readFloatLE(slice(bytes, i, i + 4)), rhtr: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x28) {
      data.tvocRawData9 = { temperature: readFloatLE(slice(bytes, i, i + 4)), iaq: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x29) {
      data.tvocRawData10 = { tvoc: readFloatLE(slice(bytes, i, i + 4)), etoh: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x2a) {
      data.tvocRawData11 = { eco2: readFloatLE(slice(bytes, i, i + 4)), relIaq: readFloatLE(slice(bytes, i + 4, i + 8)) };
      i += 8;
    } else if (commandId === 0x2b) {
      data.pmSensorWorkingTime = readUInt32LE(slice(bytes, i, i + 4));
      i += 4;

    // config
    } else if (commandId === 0x60) {
      var timeUnit = readUInt8(bytes[i]);
      data.reportingInterval = { unit: readTimeUnitType(timeUnit) };
      if (timeUnit === 0) {
        data.reportingInterval.secondsOfTime = readUInt16LE(slice(bytes, i + 1, i + 3));
      } else if (timeUnit === 1) {
        data.reportingInterval.minutesOfTime = readUInt16LE(slice(bytes, i + 1, i + 3));
      }
      i += 3;
    } else if (commandId === 0x61) {
      data.temperatureUnit = readTemperatureType(bytes[i]);
      i += 1;
    } else if (commandId === 0x62) {
      data.ledStatus = readEnableStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x63) {
      data.buzzerEnable = readEnableStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x64) {
      var index = readUInt8(bytes[i]);
      var buzzerSleep = {};
      buzzerSleep.enable = readEnableStatus(bytes[i + 1]);
      buzzerSleep.startTime = readUInt16LE(slice(bytes, i + 2, i + 4));
      buzzerSleep.endTime = readUInt16LE(slice(bytes, i + 4, i + 6));
      i += 6;
      data.buzzerSleep = data.buzzerSleep || {};
      data.buzzerSleep['item_' + index] = buzzerSleep;
    } else if (commandId === 0x65) {
      data.buzzerButtonStopEnable = readEnableStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x66) {
      data.buzzerSilentTime = readUInt16LE(slice(bytes, i, i + 2));
      i += 2;
    } else if (commandId === 0x67) {
      data.tamperAlarmEnable = readEnableStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x68) {
      data.tvocRawReportingEnable = readEnableStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x69) {
      data.temperatureAlarmSettings = {
        enable: readEnableStatus(bytes[i]),
        condition: readThresholdCondition(bytes[i + 1]),
        thresholdMin: round(readInt16LE(slice(bytes, i + 2, i + 4)) / 10, 1),
        thresholdMax: round(readInt16LE(slice(bytes, i + 4, i + 6)) / 10, 1)
      };
      i += 6;
    } else if (commandId === 0x6a) {
      data.pm1AlarmSettings = { enable: readEnableStatus(bytes[i]), thresholdMax: readInt16LE(slice(bytes, i + 4, i + 6)) };
      i += 6;
    } else if (commandId === 0x6b) {
      data.pm25AlarmSettings = { enable: readEnableStatus(bytes[i]), thresholdMax: readInt16LE(slice(bytes, i + 4, i + 6)) };
      i += 6;
    } else if (commandId === 0x6c) {
      data.pm10AlarmSettings = { enable: readEnableStatus(bytes[i]), thresholdMax: readInt16LE(slice(bytes, i + 4, i + 6)) };
      i += 6;
    } else if (commandId === 0x6d) {
      data.tvocAlarmSettings = { enable: readEnableStatus(bytes[i]), thresholdMax: readInt16LE(slice(bytes, i + 4, i + 6)) };
      i += 6;
    } else if (commandId === 0x6e) {
      data.vapingIndexAlarmSettings = { enable: readEnableStatus(bytes[i]), thresholdMax: readUInt8(bytes[i + 3]) };
      i += 4;
    } else if (commandId === 0x6f) {
      data.alarmReportingTimes = readUInt16LE(slice(bytes, i, i + 2));
      i += 2;
    } else if (commandId === 0x70) {
      data.alarmDeactivationEnable = readEnableStatus(bytes[i]);
      i += 1;
    } else if (commandId === 0x71) {
      data.temperatureCalibrationSettings = {
        enable: readEnableStatus(bytes[i]),
        calibrationValue: round(readInt16LE(slice(bytes, i + 1, i + 3)) / 10, 1)
      };
      i += 3;
    } else if (commandId === 0x72) {
      data.humidityCalibrationSettings = {
        enable: readEnableStatus(bytes[i]),
        calibrationValue: round(readInt16LE(slice(bytes, i + 1, i + 3)) / 10, 1)
      };
      i += 3;
    } else if (commandId === 0x73) {
      data.pm1CalibrationSettings = { enable: readEnableStatus(bytes[i]), calibrationValue: readInt16LE(slice(bytes, i + 1, i + 3)) };
      i += 3;
    } else if (commandId === 0x74) {
      data.pm25CalibrationSettings = { enable: readEnableStatus(bytes[i]), calibrationValue: readInt16LE(slice(bytes, i + 1, i + 3)) };
      i += 3;
    } else if (commandId === 0x75) {
      data.pm10CalibrationSettings = { enable: readEnableStatus(bytes[i]), calibrationValue: readInt16LE(slice(bytes, i + 1, i + 3)) };
      i += 3;
    } else if (commandId === 0x76) {
      data.tvocCalibrationSettings = { enable: readEnableStatus(bytes[i]), calibrationValue: readInt16LE(slice(bytes, i + 1, i + 3)) };
      i += 3;
    } else if (commandId === 0x77) {
      data.vapingIndexCalibrationSettings = { enable: readEnableStatus(bytes[i]), calibrationValue: readInt8(bytes[i + 1]) };
      i += 2;
    } else if (commandId === 0xc6) {
      var dst = {};
      dst.daylightSavingTimeEnable = readEnableStatus(bytes[i]);
      dst.daylightSavingTimeOffset = readUInt8(bytes[i + 1]);
      dst.startMonth = readUInt8(bytes[i + 2]);
      var startDayValue = readUInt8(bytes[i + 3]);
      dst.startWeekNum = (startDayValue >>> 4) & 0x07;
      dst.startWeekDay = startDayValue & 0x0f;
      dst.startHourMin = readUInt16LE(slice(bytes, i + 4, i + 6));
      dst.endMonth = readUInt8(bytes[i + 6]);
      var endDayValue = readUInt8(bytes[i + 7]);
      dst.endWeekNum = (endDayValue >>> 4) & 0x0f;
      dst.endWeekDay = endDayValue & 0x0f;
      dst.endHourMin = readUInt16LE(slice(bytes, i + 8, i + 10));
      data.daylightSavingTime = dst;
      i += 10;
    } else if (commandId === 0xc7) {
      data.timeZone = readTimeZone(readInt16LE(slice(bytes, i, i + 2)));
      i += 2;

    // service
    } else if (commandId === 0x5f) {
      data.stopBuzzerAlarm = readYesNoStatus(1);
    } else if (commandId === 0x5e) {
      data.executeTvocSelfClean = readYesNoStatus(1);
    } else if (commandId === 0xb6) {
      data.reconnect = readYesNoStatus(1);
    } else if (commandId === 0xb8) {
      data.synchronizeTime = readYesNoStatus(1);
    } else if (commandId === 0xb9) {
      data.queryDeviceStatus = readYesNoStatus(1);
    } else if (commandId === 0xbe) {
      data.reboot = readYesNoStatus(1);

    // control frame
    } else if (commandId === 0xef) {
      var cmdData = readUInt8(bytes[i]);
      var cmdResult = (cmdData >>> 4) & 0x0f;
      var cmdLength = cmdData & 0x0f;
      var cmdId = readHexString(slice(bytes, i + 1, i + 1 + cmdLength));
      var cmdHeader = readHexString(slice(bytes, i + 1, i + 2));
      i += 1 + cmdLength;
      var response = {};
      response.result = readCmdResult(cmdResult);
      response.cmdId = cmdId;
      response.cmdName = readCmdName(cmdHeader);
      data.requestResult = data.requestResult || [];
      data.requestResult.push(response);
    } else if (commandId === 0xfe) {
      data.frame = readUInt8(bytes[i]);
      i += 1;
    } else {
      return { errors: ['unknown command: ' + commandId] };
    }
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "gs601";
  }
  return result;
}
