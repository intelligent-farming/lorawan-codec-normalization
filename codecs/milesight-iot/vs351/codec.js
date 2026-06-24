// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS351 (Mini AI Thermopile people
// counter: bi-directional in/out passage counts, period counts, threshold
// alarms, ambient temperature + temperature alarm, timestamp, datalog history).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/vs351.js, in turn Milesight-IoT/SensorDecoders,
// attributed in NOTICE). Ported faithfully from that decoder's uplink path
// (milesightDeviceDecode); we author the normalization here — we do NOT copy
// upstream normalizeUplink. Sibling of the VS360 counter codec.
//
// Mapping decisions:
//   0x01/0x75 battery          byte %                -> batteryPercent extra
//   0x03/0x67 temperature      int16 LE / 10 (°C)    -> air.temperature
//   0x04/0xCC total in/out     uint16 LE x2          -> action.motion.count
//                                                       (total_in + total_out) + .detected
//                                                       + totalIn / totalOut extras
//   0x05/0xCC period in/out    uint16 LE x2          -> periodIn / periodOut extras
//   0x83/0x67 temperature alarm int16 LE / 10 + byte -> air.temperature + temperatureAlarm extra
//   0x84/0xCC total in/out alarm  + alarm byte       -> as 0x04 + totalCountAlarm extra
//   0x85/0xCC period in/out alarm + alarm byte       -> as 0x05 + periodCountAlarm extra
//   0x0A/0xEF timestamp        uint32 LE epoch       -> time (RFC3339)
//   0x20/0xCE datalog (history) mode 0 period / mode 1 period+total
//                                                    -> history[] (each with time)
//
// The VS351 is a counting device: the primary normalized measurement is
// action.motion.count, taken as the sum of in and out passages, with
// action.motion.detected = (count > 0). The raw directional and period counters
// are preserved as camelCase extras. Ambient temperature is normalized to
// air.temperature (°C); humidity is not reported by this device, so the device
// stays in the `motion` category (not `climate`). Milesight reports battery as a
// PERCENTAGE; the vocabulary's `battery` is volts, so the percentage is emitted
// as the camelCase extra `batteryPercent`. Alarm flags are camelCase extras.
// Downlink command responses (channels 0xFE/0xFF/0xF8/0xF9) are not part of the
// uplink measurement path and are not decoded here.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function i16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function alarmType(type) {
  if (type === 0) { return 'threshold_alarm_release'; }
  if (type === 1) { return 'threshold_alarm'; }
  if (type === 3) { return 'high_temperature_alarm'; }
  if (type === 4) { return 'high_temperature_alarm_release'; }
  return 'unknown';
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var motion = {};
  var hasMotion = false;
  var temperature = null;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      // BATTERY: percentage
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // TEMPERATURE: int16 LE, 0.1 °C
      temperature = round(i16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0xcc) {
      // TOTAL IN / OUT: uint16 LE each
      var tin = u16le(bytes[i + 2], bytes[i + 3]);
      var tout = u16le(bytes[i + 4], bytes[i + 5]);
      data.totalIn = tin;
      data.totalOut = tout;
      motion.count = tin + tout;
      motion.detected = (tin + tout) > 0;
      hasMotion = true;
      i += 6;
      recognized = true;
    } else if (channel === 0x05 && type === 0xcc) {
      // PERIOD IN / OUT: uint16 LE each
      data.periodIn = u16le(bytes[i + 2], bytes[i + 3]);
      data.periodOut = u16le(bytes[i + 4], bytes[i + 5]);
      i += 6;
      recognized = true;
    } else if (channel === 0x83 && type === 0x67) {
      // TEMPERATURE ALARM: int16 LE 0.1 °C + alarm byte
      temperature = round(i16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      data.temperatureAlarm = alarmType(bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (channel === 0x84 && type === 0xcc) {
      // TOTAL IN / OUT ALARM: uint16 LE each + alarm byte
      var atin = u16le(bytes[i + 2], bytes[i + 3]);
      var atout = u16le(bytes[i + 4], bytes[i + 5]);
      data.totalIn = atin;
      data.totalOut = atout;
      data.totalCountAlarm = bytes[i + 6] === 1 ? 'threshold_alarm' : 'unknown';
      motion.count = atin + atout;
      motion.detected = (atin + atout) > 0;
      hasMotion = true;
      i += 7;
      recognized = true;
    } else if (channel === 0x85 && type === 0xcc) {
      // PERIOD IN / OUT ALARM: uint16 LE each + alarm byte
      data.periodIn = u16le(bytes[i + 2], bytes[i + 3]);
      data.periodOut = u16le(bytes[i + 4], bytes[i + 5]);
      data.periodCountAlarm = bytes[i + 6] === 1 ? 'threshold_alarm' : 'unknown';
      i += 7;
      recognized = true;
    } else if (channel === 0x0a && type === 0xef) {
      // TIMESTAMP: uint32 LE epoch seconds
      var epoch = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      if (epoch > 0) {
        data.time = new Date(epoch * 1000).toISOString();
      }
      i += 6;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      // DATALOG / HISTORY: epoch + mode (0 = period only, 1 = period + total)
      var hEpoch = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      var mode = bytes[i + 6];
      var point = {};
      if (hEpoch > 0) {
        point.time = new Date(hEpoch * 1000).toISOString();
      }
      if (mode === 0x00) {
        point.periodIn = u16le(bytes[i + 7], bytes[i + 8]);
        point.periodOut = u16le(bytes[i + 9], bytes[i + 10]);
        i += 11;
      } else if (mode === 0x01) {
        point.periodIn = u16le(bytes[i + 7], bytes[i + 8]);
        point.periodOut = u16le(bytes[i + 9], bytes[i + 10]);
        point.totalIn = u16le(bytes[i + 11], bytes[i + 12]);
        point.totalOut = u16le(bytes[i + 13], bytes[i + 14]);
        i += 15;
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

  if (temperature !== null) {
    data.air = { temperature: temperature };
  }

  if (hasMotion) {
    data.action = { motion: motion };
  }

  return { data: data };
}
