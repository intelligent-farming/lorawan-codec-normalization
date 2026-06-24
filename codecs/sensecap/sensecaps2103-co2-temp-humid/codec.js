// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SenseCAP S2103 (LoRaWAN CO2, Temperature, and
// Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire format
// (the SenseCAP S210x measurement-ID protocol) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/sensecap/sensecap210x-codec.js a.k.a. the "SenseCAP & TTN (new v3)
// Converter", attributed in NOTICE).
//
// Ported from upstream decodeUplink: the frame parser below
// (bytes2HexString / divideBy7Bytes / strTo10SysNub / ttnDataFormat /
// ttnDataSpecialFormat and helpers) is a faithful ES5 port of the upstream
// decoder. The authored normalization (NOT upstream's `messages` array output)
// maps each report_telemetry message onto the shared vocabulary by its
// measurementId.
//
// Wire format: payload is N frames of 7 bytes each followed by 2 trailing
// CRC bytes; the length check is (byteLen - 2) % 7 === 0. Each 7-byte frame is
// [channel(1B), dataId(2B little-endian), dataValue(4B little-endian)]. A dataId
// > 4096 is a telemetry reading whose value is a signed (two's-complement)
// 32-bit little-endian integer divided by 1000, yielding the value in its
// natural unit. SenseCAP S210x measurement IDs used by the S2103:
//   4097 (0x1001) -> air temperature (degC)   -> air.temperature
//   4098 (0x1002) -> air humidity (%RH)        -> air.relativeHumidity
//   4100 (0x1004) -> CO2 (ppm)                 -> air.co2
// Other dataIds are device control/metadata frames (version, sensor EUI,
// battery + interval, remove-sensor). Battery is reported as a PERCENTAGE; the
// vocabulary's `battery` is volts, so it is emitted as the camelCase extra
// `batteryPercent`. The reporting interval (seconds) becomes the camelCase
// extra `reportingInterval`; other control frames carry no field measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// --- ported upstream helpers -------------------------------------------------

function bytes2HexString(arrBytes) {
  var str = '';
  for (var i = 0; i < arrBytes.length; i++) {
    var tmp;
    var num = arrBytes[i];
    if (num < 0) {
      tmp = (255 + num + 1).toString(16);
    } else {
      tmp = num.toString(16);
    }
    if (tmp.length === 1) {
      tmp = '0' + tmp;
    }
    str += tmp;
  }
  return str;
}

function divideBy7Bytes(str) {
  var frameArray = [];
  for (var i = 0; i < str.length - 4; i += 14) {
    var data = str.substring(i, i + 14);
    frameArray.push(data);
  }
  return frameArray;
}

function littleEndianTransform(data) {
  var dataArray = [];
  for (var i = 0; i < data.length; i += 2) {
    dataArray.push(data.substring(i, i + 2));
  }
  dataArray.reverse();
  return dataArray;
}

function strTo10SysNub(str) {
  var arr = littleEndianTransform(str);
  return parseInt(arr.toString().replace(/,/g, ''), 16);
}

function checkDataIdIsMeasureUpload(dataId) {
  return parseInt(dataId) > 4096;
}

function isSpecialDataId(dataID) {
  switch (dataID) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 7:
    case 0x120:
      return true;
    default:
      return false;
  }
}

function toBinary(arr) {
  var binaryData = [];
  for (var forArr = 0; forArr < arr.length; forArr++) {
    var item = arr[forArr];
    var data = parseInt(item, 16).toString(2);
    var dataLength = data.length;
    if (data.length !== 8) {
      for (var i = 0; i < 8 - dataLength; i++) {
        data = '0' + data;
      }
    }
    binaryData.push(data);
  }
  return binaryData.toString().replace(/,/g, '');
}

function ttnDataSpecialFormat(dataId, str) {
  var strReverse = littleEndianTransform(str);
  if (dataId === 2 || dataId === 3) {
    return strReverse.join('');
  }

  var str2 = toBinary(strReverse);

  var dataArray = [];
  switch (dataId) {
    case 0: // DATA_BOARD_VERSION
    case 1: // DATA_SENSOR_VERSION
      for (var k = 0; k < str2.length; k += 16) {
        var tmp146 = str2.substring(k, k + 16);
        tmp146 = (parseInt(tmp146.substring(0, 8), 2) || 0) + '.' + (parseInt(tmp146.substring(8, 16), 2) || 0);
        dataArray.push(tmp146);
      }
      return dataArray.join(',');
    case 4:
      for (var i = 0; i < str2.length; i += 8) {
        var item = parseInt(str2.substring(i, i + 8), 2);
        if (item < 10) {
          item = '0' + item.toString();
        } else {
          item = item.toString();
        }
        dataArray.push(item);
      }
      return dataArray.join('');
    case 7:
      // battery && interval
      return {
        interval: parseInt(str2.substr(0, 16), 2),
        power: parseInt(str2.substr(-16, 16), 2),
      };
    default:
      return undefined;
  }
}

function ttnDataFormat(str) {
  var strReverse = littleEndianTransform(str);
  var str2 = toBinary(strReverse);
  if (str2.substring(0, 1) === '1') {
    var arr = str2.split('');
    var reverseArr = [];
    for (var forArr = 0; forArr < arr.length; forArr++) {
      var item = arr[forArr];
      if (parseInt(item) === 1) {
        reverseArr.push(0);
      } else {
        reverseArr.push(1);
      }
    }
    str2 = parseInt(reverseArr.join(''), 2) + 1;
    return parseFloat('-' + str2 / 1000);
  }
  return parseInt(str2, 2) / 1000;
}

// --- authored normalization --------------------------------------------------

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short for a SenseCAP S210x frame'] };
  }

  var bytesString = bytes2HexString(bytes).toLocaleUpperCase();

  // Length check: payload is N 7-byte frames + 2 CRC bytes.
  if ((bytesString.length / 2 - 2) % 7 !== 0) {
    return { errors: ['length check fail: payload is not N*7 + 2 bytes'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;
  var hasTelemetry = false;

  var frameArray = divideBy7Bytes(bytesString);
  for (var f = 0; f < frameArray.length; f++) {
    var frame = frameArray[f];
    var dataID = strTo10SysNub(frame.substring(2, 6));
    var dataValue = frame.substring(6, 14);
    var realDataValue = isSpecialDataId(dataID)
      ? ttnDataSpecialFormat(dataID, dataValue)
      : ttnDataFormat(dataValue);

    if (checkDataIdIsMeasureUpload(dataID)) {
      // Telemetry reading. Map by SenseCAP measurement ID.
      if (dataID === 4097) {
        air.temperature = round(realDataValue, 1);
        hasAir = true;
      } else if (dataID === 4098) {
        air.relativeHumidity = round(realDataValue, 1);
        hasAir = true;
      } else if (dataID === 4100) {
        // CO2 ppm. realDataValue is already in ppm (raw / 1000).
        air.co2 = round(realDataValue, 0);
        hasAir = true;
      } else {
        // Unmodeled telemetry channel -> camelCase extra keyed by id.
        data['measurement' + dataID] = realDataValue;
      }
      hasTelemetry = true;
    } else if (dataID === 7) {
      // Battery percentage + reporting interval (seconds).
      data.batteryPercent = realDataValue.power;
      data.reportingInterval = parseInt(realDataValue.interval, 10) * 60;
    }
    // Other control/metadata frames (version, sensor EUI, remove-sensor)
    // carry no field measurement and are intentionally dropped.
  }

  if (hasAir) {
    data.air = air;
  }

  if (!hasTelemetry && data.batteryPercent === undefined) {
    return { errors: ['no telemetry in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sensecap";
    result.data.model = "sensecaps2103-co2-temp-humid";
  }
  return result;
}
