// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko MCF-LW12VOC (Indoor Environmental
// Sensor: temperature, humidity, pressure, light/lux, bVOC/IAQ, battery).
// Enginko is the MCF88 rebrand; this is the VOC-equipped variant of the
// MCF-LW12 environmental family (sibling of mcf-lw12co2).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 data-frame format) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-environmental.js parseVOC/parseVOCMeasurement,
// attributed in NOTICE) and the Enginko "data_frame_format" documentation. We
// author the normalization here; the upstream getTemperature/getPressure
// string-slicing and parseUnsignedShort helpers are not reused.
//
// Frames emitted by this device family share one base measurement record:
//   date(4 LSB) temperature(2 LSB, signed, x100) humidity(1, x2) pressure(3 LSB,
//   x100) [lux(2 LSB)] [voc(2 or 3 LSB)]
// and may pack multiple measurements per uplink (newest last) followed by an
// optional battery-percentage byte. The newest measurement is emitted at the top
// level; older ones go into the `history` array (each with an RFC3339 `time`).
//
// VOC width distinguishes the two air-quality readings the family exposes:
//   - old sensor VOC frame 0x0C: 2-byte VOC = IAQ index (0-500) -> extra `iaq`
//   - new sensor VOC frame 0x12: 3-byte VOC = bVOC in ppb      -> extra `tvoc`
// The plain TER frame 0x04 carries only temperature/humidity/pressure (no
// lux/VOC).
//
// Battery is reported as a PERCENTAGE; the vocabulary `battery` is volts, so the
// percentage is emitted as the camelCase extra `batteryPercent`. The wire format
// carries no battery voltage, so `battery` is not emitted.

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

function u24le(lo, mi, hi) {
  return ((hi << 16) | (mi << 8) | lo) & 0xffffff;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Enginko/MCF88 packed timestamp: 4 LSB bytes -> 32-bit value, fields are
// year-2000(7) month(4) day(5) hour(5) minute(6) second/2(5), MSB-first within
// the assembled word. Returns an RFC3339 string (treated as UTC).
function decodeTime(b0, b1, b2, b3) {
  var v = ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
  var year = ((v >>> 25) & 0x7f) + 2000;
  var month = (v >>> 21) & 0x0f;
  var day = (v >>> 16) & 0x1f;
  var hour = (v >>> 11) & 0x1f;
  var minute = (v >>> 5) & 0x3f;
  var second = (v & 0x1f) * 2;
  return (
    year +
    '-' +
    pad2(month) +
    '-' +
    pad2(day) +
    'T' +
    pad2(hour) +
    ':' +
    pad2(minute) +
    ':' +
    pad2(second) +
    'Z'
  );
}

// Reads one measurement record starting at offset `o`. `vocLen` is the byte
// width of the VOC field (0 = no lux/VOC, as in the plain TER frame; 2 = IAQ
// index; 3 = bVOC ppb). Returns an object with `measurement` and `next`
// (offset), or null if the record runs past the end of the buffer.
function readMeasurement(bytes, o, vocLen) {
  var size = 4 + 2 + 1 + 3;
  if (vocLen > 0) {
    size += 2 + vocLen;
  }
  if (o + size > bytes.length) {
    return null;
  }

  var air = {};
  air.temperature = round(s16le(bytes[o + 4], bytes[o + 5]) / 100, 2);
  air.relativeHumidity = round(bytes[o + 6] / 2, 1);
  air.pressure = round(u24le(bytes[o + 7], bytes[o + 8], bytes[o + 9]) / 100, 2);

  var p = o + 10;
  if (vocLen > 0) {
    // 16-bit LE illuminance in lux (genuine lux per the datasheet, unit `lx`).
    air.lightIntensity = u16le(bytes[p], bytes[p + 1]);
    p += 2;
    if (vocLen === 3) {
      // New sensor: 24-bit LE bVOC in ppb.
      air.tvoc = u24le(bytes[p], bytes[p + 1], bytes[p + 2]);
    } else {
      // Old sensor: 16-bit LE IAQ index (0-500).
      air.iaq = u16le(bytes[p], bytes[p + 1]);
    }
    p += vocLen;
  }

  var m = { air: air };
  m.time = decodeTime(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  return { measurement: m, next: o + size };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var id = bytes[0];
  var vocLen;

  if (id === 0x04) {
    // TER frame: temperature / humidity / pressure only (no lux/VOC).
    vocLen = 0;
  } else if (id === 0x0c) {
    // Old VOC frame: lux + 2-byte IAQ index.
    vocLen = 2;
  } else if (id === 0x12) {
    // New VOC frame: lux + 3-byte bVOC (ppb).
    vocLen = 3;
  } else {
    return {
      errors: ['unsupported frame id 0x' + id.toString(16)]
    };
  }

  var measurements = [];
  var o = 1;
  var rec = readMeasurement(bytes, o, vocLen);
  while (rec !== null) {
    measurements.push(rec.measurement);
    o = rec.next;
    rec = readMeasurement(bytes, o, vocLen);
  }

  if (measurements.length === 0) {
    return { errors: ['no complete measurement in frame 0x' + id.toString(16)] };
  }

  // Optional trailing battery-percentage byte (after the last full record).
  var batteryPercent;
  if (o < bytes.length) {
    batteryPercent = bytes[o];
  }

  // Newest measurement is last in the frame -> top level; older -> history.
  var newest = measurements[measurements.length - 1];
  var data = {};
  data.air = newest.air;
  data.time = newest.time;
  if (batteryPercent !== undefined) {
    data.batteryPercent = batteryPercent;
  }

  if (measurements.length > 1) {
    var history = [];
    var i;
    for (i = measurements.length - 2; i >= 0; i--) {
      history.push(measurements[i]);
    }
    data.history = history;
  }

  return { data: data };
}
