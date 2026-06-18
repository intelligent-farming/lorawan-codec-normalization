// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight WS203 (wall-mount occupancy/PIR +
// temperature + humidity sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/ws203.js, attributed in NOTICE). Ported faithfully from
// the upstream decodeUplink/milesight() TLV walk; do NOT copy upstream
// normalizeUplink.
//
// Mapping decisions:
//   0x01/0x75 battery               byte %                 -> batteryPercent extra
//   0x03/0x67 temperature           int16 LE /10 °C        -> air.temperature
//   0x04/0x68 humidity              byte /2 %              -> air.relativeHumidity
//   0x05/0x00 occupancy             byte (0 = vacant)      -> action.motion.detected
//                                                             (occupied -> true) +
//                                                             occupancy string extra
//   0x83/0x67 temperature+abnormal  int16 LE /10 °C + flag -> air.temperature +
//                                                             temperatureAbnormal extra
//   0x20/0xCE historical record     uint32 ts + flags + TH -> history[] entries
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. Occupancy is the WS203's PIR
// signal, so it normalizes to action.motion.detected (occupied -> true); the
// human-readable "vacant"/"occupied" string is kept as the camelCase extra
// `occupancy`. The 0x83 abnormal-temperature flag and 0x20 datalog report type
// have no vocabulary key and are camelCase extras (temperatureAbnormal,
// reportType). Historical (0x20/0xCE) records are placed in the `history` array,
// each carrying an RFC3339 `time` derived from the record's unix timestamp.

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

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

// Unix epoch seconds -> RFC3339 (UTC). Avoids Date string parsing so output is
// stable across engines; uses Date only for the UTC field breakdown.
function epochToRfc3339(seconds) {
  var d = new Date(seconds * 1000);
  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  return (
    d.getUTCFullYear() +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    ':' +
    pad2(d.getUTCMinutes()) +
    ':' +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

var REPORT_TYPES = [
  'temperature resume',
  'temperature threshold',
  'pir idle',
  'pir occupancy',
  'period'
];

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var history = [];
  var hasAir = false;
  var hasMotion = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY: 1 byte percentage
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C resolution
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 % resolution
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // OCCUPANCY: 1 byte (0 = vacant, non-zero = occupied)
      var occupied = bytes[i + 2] !== 0;
      motion.detected = occupied;
      data.occupancy = occupied ? 'occupied' : 'vacant';
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x83 && type === 0x67) {
      // TEMPERATURE WITH ABNORMAL: int16 LE /10 °C + 1-byte abnormal flag
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      data.temperatureAbnormal = bytes[i + 4] === 0 ? 'normal' : 'abnormal';
      hasAir = true;
      i += 5;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      // HISTORICAL DATA: uint32 timestamp + report type + occupancy + TH
      var ts = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      var reportType = bytes[i + 6];
      var entryOccupied = bytes[i + 7] !== 0;
      var entry = {
        time: epochToRfc3339(ts),
        reportType: REPORT_TYPES[reportType & 0x07],
        occupancy: entryOccupied ? 'occupied' : 'vacant',
        action: { motion: { detected: entryOccupied } },
        air: {
          temperature: round(s16le(bytes[i + 8], bytes[i + 9]) / 10, 1),
          relativeHumidity: round(bytes[i + 10] / 2, 1)
        }
      };
      history.push(entry);
      i += 11;
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
  if (hasMotion) {
    data.action = { motion: motion };
  }
  if (history.length > 0) {
    data.history = history;
  }

  return { data: data };
}
