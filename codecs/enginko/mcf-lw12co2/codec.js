// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LW12CO2 (Indoor
// Environmental Sensor: temperature, humidity, pressure, light, bVOC/IAQ, CO2).
// Enginko is the MCF88 rebrand; this is the same device as mcf88/mcf-lw12co2.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 data-frame format) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/mcf-environmental-codec.js, attributed in NOTICE) and the
// Enginko "data_frame_format" documentation. We author the normalization here;
// the upstream getTemperature/getPressure string-slicing helpers are not reused.
//
// Frames emitted by this device family share one base measurement record:
//   date(4 LSB) temperature(2 LSB, signed, x100) humidity(1, x2) pressure(3 LSB,
//   x100) [lux(2 LSB)] [voc(2 or 3 LSB)] [co2(2 LSB, signed)]
// and may pack multiple measurements per uplink (newest last) followed by an
// optional battery-percentage byte. The newest measurement is emitted at the top
// level; older ones go into the `history` array (each with an RFC3339 `time`).
//
// Battery is reported as a PERCENTAGE; the vocabulary `battery` is volts, so the
// percentage is emitted as the camelCase extra `batteryPercent`.

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

// MCF88/Enginko packed timestamp: 4 LSB bytes -> 32-bit value, fields are
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
// width of the VOC field (0 = no VOC/lux, 2 or 3 = present); `hasCo2` adds a
// trailing 2-byte signed CO2 value. Returns an object with `measurement` and
// `next` (offset), or null if the record runs past the end of the buffer.
function readMeasurement(bytes, o, vocLen, hasCo2) {
  var size = 4 + 2 + 1 + 3;
  if (vocLen > 0) {
    size += 2 + vocLen;
  }
  if (hasCo2) {
    size += 2;
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
    air.lightIntensity = u16le(bytes[p], bytes[p + 1]);
    p += 2;
    var voc;
    if (vocLen === 3) {
      voc = u24le(bytes[p], bytes[p + 1], bytes[p + 2]);
    } else {
      voc = u16le(bytes[p], bytes[p + 1]);
    }
    air.bvoc = voc;
    p += vocLen;
  }
  if (hasCo2) {
    air.co2 = s16le(bytes[p], bytes[p + 1]);
    p += 2;
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
  var hasCo2;

  if (id === 0x04) {
    vocLen = 0;
    hasCo2 = false;
  } else if (id === 0x0c) {
    vocLen = 2;
    hasCo2 = false;
  } else if (id === 0x12) {
    vocLen = 3;
    hasCo2 = false;
  } else if (id === 0x0e) {
    vocLen = 2;
    hasCo2 = true;
  } else if (id === 0x13) {
    vocLen = 3;
    hasCo2 = true;
  } else {
    return {
      errors: ['unsupported frame id 0x' + id.toString(16)]
    };
  }

  var measurements = [];
  var o = 1;
  var rec = readMeasurement(bytes, o, vocLen, hasCo2);
  while (rec !== null) {
    measurements.push(rec.measurement);
    o = rec.next;
    rec = readMeasurement(bytes, o, vocLen, hasCo2);
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
