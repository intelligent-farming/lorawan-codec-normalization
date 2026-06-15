// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCF88 / Enginko MCF-LW12TERPM (outdoor
// weather station: temperature, humidity, barometric pressure, and
// particulate matter PM1/PM2.5/PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCF88 "report data" 0x0B frame) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcf88/decoder-environmental.js, attributed in NOTICE) — specifically
// its parseReportData/parseTERPM path — and the sibling TER decode in
// codecs/mcf88/mcf-lw12co2/codec.js. We author the normalization here; the
// upstream getTemperature/getPressure string-slicing helpers and its
// locale-dependent parseDate (new Date(...).toLocaleString()) are NOT reused —
// the date is emitted as a deterministic RFC3339 UTC string instead.
//
// TERPM report frame (1 measurement per uplink), little-endian fields:
//   id(0x0B) subType(high nibble 0x3) subSubType(0x00)
//   date(4 LSB) temperature(2 LSB, signed, x100) humidity(1, x2)
//   pressure(3 LSB, x100) pm1(2 LSB) pm2.5(2 LSB) pm10(2 LSB)
//   [battery-percent(1)]
// The trailing battery byte is present only when the frame carries it (>=20
// bytes). The newest (only) measurement is emitted at the top level; the
// `history` array is reserved for datalog frames that pack multiple records.
//
// Battery is reported as a PERCENTAGE; the vocabulary `battery` is volts, so
// the percentage is emitted as the camelCase extra `batteryPercent`. PM values
// (micrograms/m^3) are not in the vocabulary and are emitted as the camelCase
// extras `pm1`, `pm2_5`, `pm10`.

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

// MCF88 packed timestamp: 4 LSB bytes -> 32-bit value, fields are
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

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var id = bytes[0];
  if (id !== 0x0b) {
    return { errors: ['unsupported frame id 0x' + id.toString(16)] };
  }

  // Report-data dispatch: high nibble of byte[1] selects the report family;
  // byte[2] selects the variant. TERPM is 0x3 / 0x00.
  if (bytes.length < 3) {
    return { errors: ['truncated report-data frame'] };
  }
  var subType = (bytes[1] >> 4) & 0x0f;
  var subSubType = bytes[2];
  if (subType !== 0x3 || subSubType !== 0x00) {
    return {
      errors: [
        'unsupported report-data frame (subType 0x' +
          subType.toString(16) +
          ', variant 0x' +
          pad2(subSubType) +
          ')'
      ]
    };
  }

  // Fixed TERPM record: date(4) temp(2) hum(1) pressure(3) pm1(2) pm2.5(2)
  // pm10(2) = 16 bytes of measurement after the 3-byte header => 19 bytes,
  // plus an optional trailing battery-percent byte.
  if (bytes.length < 19) {
    return { errors: ['truncated TERPM measurement'] };
  }

  var air = {};
  air.temperature = round(s16le(bytes[7], bytes[8]) / 100, 2);
  air.relativeHumidity = round(bytes[9] / 2, 1);
  air.pressure = round(u24le(bytes[10], bytes[11], bytes[12]) / 100, 2);

  var data = {};
  data.air = air;
  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);
  data.pm1 = u16le(bytes[13], bytes[14]);
  data.pm2_5 = u16le(bytes[15], bytes[16]);
  data.pm10 = u16le(bytes[17], bytes[18]);

  if (bytes.length >= 20) {
    data.batteryPercent = bytes[19];
  }

  return { data: data };
}
