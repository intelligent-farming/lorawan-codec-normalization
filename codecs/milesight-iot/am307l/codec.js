// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight AM307L (Ambience Monitoring Sensor;
// shares the AM307/AM319 wire format).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/am307l.js, attributed in NOTICE). Do NOT copy upstream
// normalizeUplink; the normalization below is authored.
//
// Channels:
//   0x01/0x75 battery — PERCENTAGE; the vocabulary `battery` is volts, so the
//             percentage is emitted as the camelCase extra `batteryPercent`.
//   0x03/0x67 temperature — int16 LE, 0.1 °C -> air.temperature.
//   0x04/0x68 humidity — byte, 0.5 % -> air.relativeHumidity.
//   0x05/0x00 PIR occupancy — 1 byte state (1 = triggered). The AM307L reports a
//             boolean occupancy state, not an event count, so this maps to
//             action.motion.detected = (state === 1). (Distinct from the AM104/
//             AM107 PIR channel 0x05/0x6A, which is a uint16 event count and is
//             intentionally NOT recognized here.)
//   0x06/0xCB light level — 1 byte index (0..5), NOT lux illuminance. It does
//             not satisfy air.lightIntensity (lux), so it is emitted as the
//             camelCase extra `lightLevel`.
//   0x07/0x7D CO2 — uint16 ppm -> air.co2.
//   0x08/0x7D TVOC — uint16, no vocabulary key -> camelCase extra `tvoc`.
//   0x09/0x73 pressure — uint16, 0.1 hPa -> air.pressure.
//   0x0A/0x7D HCHO — uint16, 0.01 mg/m3, no vocabulary key -> extra `hcho`.
//   0x0B/0x7D PM2.5 — uint16 ug/m3, no vocabulary key -> extra `pm2_5`.
//   0x0C/0x7D PM10 — uint16 ug/m3, no vocabulary key -> extra `pm10`.
//   0x0D/0x7D O3 — uint16, 0.01 ppm, no vocabulary key -> extra `o3`.
//   0x0E/0x01 beep/alarm — 1 byte boolean, no vocabulary key -> extra `beep`.

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
      // TEMPERATURE: int16 LE, 0.1 degC
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // HUMIDITY: 1 byte, 0.5 %
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      // PIR OCCUPANCY: 1 byte state (1 = triggered)
      motion.detected = bytes[i + 2] === 1;
      hasMotion = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0xcb) {
      // LIGHT LEVEL: 1 byte index (not lux) -> extra
      data.lightLevel = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x07 && type === 0x7d) {
      // CO2: uint16 ppm
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x08 && type === 0x7d) {
      // TVOC: uint16 -> extra
      data.tvoc = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x09 && type === 0x73) {
      // PRESSURE: uint16, 0.1 hPa
      air.pressure = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      hasAir = true;
      i += 4;
      recognized = true;
    } else if (channel === 0x0a && type === 0x7d) {
      // HCHO: uint16, 0.01 mg/m3 -> extra
      data.hcho = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x0b && type === 0x7d) {
      // PM2.5: uint16 ug/m3 -> extra
      data.pm2_5 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x0c && type === 0x7d) {
      // PM10: uint16 ug/m3 -> extra
      data.pm10 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x0d && type === 0x7d) {
      // O3: uint16, 0.01 ppm -> extra
      data.o3 = round(u16le(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x0e && type === 0x01) {
      // BEEP/ALARM: 1 byte boolean -> extra
      data.beep = bytes[i + 2] === 1;
      i += 3;
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
    if (!data.action) {
      data.action = {};
    }
    data.action.motion = motion;
  }

  return { data: data };
}
