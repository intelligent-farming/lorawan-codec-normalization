// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS321 (Wireless AI Workplace /
// Occupancy Sensor: people counting, per-region occupancy, ambient
// temperature + humidity, illuminance status).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/vs321.js, attributed in NOTICE). Ported faithfully from
// that decoder's uplink path (milesightDeviceDecode); we author the
// normalization here — we do NOT copy upstream normalizeUplink.
//
// Mapping decisions:
//   0x03/0x67 temperature   int16 LE /10 °C        -> air.temperature
//                                                     (0xFFFF -> temperatureSensorStatus extra)
//   0x04/0x68 humidity       byte /2 %             -> air.relativeHumidity
//                                                     (0xFF   -> humiditySensorStatus extra)
//   0x05/0xFD people counts  uint16 LE             -> action.motion.count (+ .detected)
//                                                     + peopleTotalCounts extra
//   0x06/0xFE region occupancy mask+data (10 regions)
//                                                  -> regionN / regionNEnable extras
//                                                     (any occupied -> action.motion.detected)
//   0x07/0xFF illuminance     byte (0 dim/1 bright) -> illuminanceStatus extra
//   0x08/0xF4 detection       status byte           -> detectionStatus extra
//   0x0A/0xEF timestamp       uint32 LE epoch       -> time (RFC3339)
//   0x83/0x67 temperature alarm int16 LE /10 + flag -> air.temperature + temperatureAlarm extra
//   0x84/0x68 humidity alarm    byte /2 + flag       -> air.relativeHumidity + humidityAlarm extra
//   0x20/0xCE datalog (history) mode 0 counts / mode 1 region occupancy
//                                                  -> history[] (each with time)
//   0x01/0x75 battery         byte %                -> batteryPercent extra
//
// Milesight reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`.
// Occupancy is the primary measurement: people count and per-region occupancy
// drive the normalized `action.motion` (count + detected); the raw per-region
// strings and people total are also preserved as camelCase extras. Downlink
// command responses are not part of the uplink measurement path and are not
// decoded here.

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

function occupancyStatus(bit) {
  return bit ? 'occupied' : 'vacant';
}

function enableStatus(bit) {
  return bit ? 'enable' : 'disable';
}

function regionKey(index) {
  return 'region' + (index + 1);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var hasAir = false;
  var hasMotion = false;
  var recognized = false;
  var r;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C; 0xFFFF marks a sensor fault
      if (u16le(bytes[i + 2], bytes[i + 3]) === 0xffff) {
        data.temperatureSensorStatus = 'read_failed';
      } else {
        air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
        hasAir = true;
      }
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 %; 0xFF marks a sensor fault
      if (bytes[i + 2] === 0xff) {
        data.humiditySensorStatus = 'read_failed';
      } else {
        air.relativeHumidity = round(bytes[i + 2] / 2, 1);
        hasAir = true;
      }
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0xfd) {
      // PEOPLE TOTAL COUNTS: uint16 LE
      var count = u16le(bytes[i + 2], bytes[i + 3]);
      data.peopleTotalCounts = count;
      motion.count = count;
      if (count > 0) {
        motion.detected = true;
      }
      hasMotion = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x06 && type === 0xfe) {
      // REGION OCCUPANCY: 16-bit enable mask + 16-bit occupancy data, 10 regions
      var regionMask = u16le(bytes[i + 2], bytes[i + 3]);
      var regionData = u16le(bytes[i + 4], bytes[i + 5]);
      var anyOccupied = false;
      var ri;
      for (ri = 0; ri < 10; ri++) {
        var enabled = (regionMask >>> ri) & 0x01;
        var occupied = (regionData >>> ri) & 0x01;
        data[regionKey(ri) + 'Enable'] = enableStatus(enabled);
        data[regionKey(ri)] = occupancyStatus(occupied);
        if (occupied) {
          anyOccupied = true;
        }
      }
      if (anyOccupied) {
        motion.detected = true;
      } else if (motion.detected === undefined) {
        motion.detected = false;
      }
      hasMotion = true;
      i += 6;
      recognized = true;
    } else if (channel === 0x07 && type === 0xff) {
      // ILLUMINANCE STATUS: 0 = dim, 1 = bright
      data.illuminanceStatus = bytes[i + 2] ? 'bright' : 'dim';
      i += 3;
      recognized = true;
    } else if (channel === 0x08 && type === 0xf4) {
      // CONFIDENCE / DETECTION STATUS: skip first byte; 0 = normal, 1 = unavailable
      data.detectionStatus = bytes[i + 3] ? 'unavailable' : 'normal';
      i += 4;
      recognized = true;
    } else if (channel === 0x0a && type === 0xef) {
      // TIMESTAMP: uint32 LE epoch seconds
      var epoch = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      if (epoch > 0) {
        data.time = new Date(epoch * 1000).toISOString();
      }
      i += 6;
      recognized = true;
    } else if (channel === 0x83 && type === 0x67) {
      // TEMPERATURE ALARM: int16 LE /10 + alarm flag
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      data.temperatureAlarm = bytes[i + 4] ? 'threshold_alarm' : 'threshold_alarm_release';
      hasAir = true;
      i += 5;
      recognized = true;
    } else if (channel === 0x84 && type === 0x68) {
      // HUMIDITY ALARM: byte /2 + alarm flag
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      data.humidityAlarm = bytes[i + 3] ? 'threshold_alarm' : 'threshold_alarm_release';
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      // DATALOG / HISTORY: epoch + mode (0 = people counts, 1 = region occupancy)
      var hEpoch = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      var mode = bytes[i + 6];
      var point = {};
      if (hEpoch > 0) {
        point.time = new Date(hEpoch * 1000).toISOString();
      }
      if (mode === 0x00) {
        point.peopleTotalCounts = u16le(bytes[i + 7], bytes[i + 8]);
        i += 9;
      } else if (mode === 0x01) {
        var hMask = u16le(bytes[i + 7], bytes[i + 8]);
        var hData = u16le(bytes[i + 9], bytes[i + 10]);
        for (r = 0; r < 10; r++) {
          point[regionKey(r) + 'Enable'] = enableStatus((hMask >>> r) & 0x01);
          point[regionKey(r)] = occupancyStatus((hData >>> r) & 0x01);
        }
        i += 11;
      } else {
        return { errors: ['unknown datalog mode: ' + mode] };
      }
      if (!data.history) {
        data.history = [];
      }
      data.history.push(point);
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

  return { data: data };
}
