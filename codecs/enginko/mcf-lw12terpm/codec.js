// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enginko / MCF88 MCF-LW12TERPM (Outdoor
// Environmental Sensor: temperature, humidity, barometric pressure, and
// particulate matter PM1 / PM2.5 / PM10). Enginko is the MCF88 rebrand; this is
// the same device as mcf88/mcf-lw12terpm.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enginko/MCF88 "ReportData" 0x0B TERPM frame) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enginko/decoder-environmental.js, attributed in NOTICE) and the Enginko
// "data_frame_format" documentation. Ported faithfully from the upstream
// decodeUplink/parseReportData/parseTERPM path; we author the normalization here.
// The upstream getTemperature/getPressure string-slicing helpers and the
// non-deterministic toLocaleString() date are not reused — temperature, humidity
// and pressure are decoded with the same arithmetic, and the packed timestamp is
// emitted as an RFC3339 (UTC) string.
//
// TERPM frame (frame id 0x0B, subtype nibble 0x3, data type 0x00):
//   0x0B | 0x3_ | 0x00 | date(4 LSB) | temperature(2 LSB, signed, x100) |
//   humidity(1, x2) | pressure(3 LSB, x100) | pm1(2 LSB) | pm2.5(2 LSB) |
//   pm10(2 LSB) | [battery percent(1)]
// The frame carries a single measurement (no datalog/history). The trailing
// battery byte is optional (present when the frame is longer than 19 bytes).
//
// PM concentrations (ug/m3) are not modelled by the shared vocabulary, so they
// are emitted as the camelCase extras `pm1` / `pm2_5` / `pm10`. This device's
// TERPM frame carries no IAQ/VOC or CO2 channel. Battery is reported as a
// PERCENTAGE; the vocabulary `battery` is volts, so the percentage is emitted as
// the camelCase extra `batteryPercent`.

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

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var id = bytes[0];
  if (id !== 0x0b) {
    return { errors: ['unsupported frame id 0x' + id.toString(16)] };
  }

  // Byte 1 high nibble is the report-data subtype; the TERPM measurement is
  // subtype 0x3 (matches upstream payload.substring(2,3) === '3').
  var subtype = (bytes[1] >>> 4) & 0x0f;
  // Byte 2 is the data type; the TERPM measurement is 0x00 (matches upstream
  // payload.substring(4,6) === '00').
  var dataType = bytes[2];
  if (subtype !== 0x3 || dataType !== 0x00) {
    return {
      errors: [
        'unsupported report-data frame (subtype 0x' +
          subtype.toString(16) +
          ', type 0x' +
          dataType.toString(16) +
          ')'
      ]
    };
  }

  // Fixed-layout record begins at byte 3. Need 16 data bytes (date..pm10);
  // the trailing battery byte (offset 19) is optional.
  if (bytes.length < 19) {
    return { errors: ['truncated TERPM frame'] };
  }

  var air = {};
  air.temperature = round(s16le(bytes[7], bytes[8]) / 100, 2);
  air.relativeHumidity = round(bytes[9] / 2, 1);
  air.pressure = round(u24le(bytes[10], bytes[11], bytes[12]) / 100, 2);

  var data = {};
  data.air = air;
  data.pm1 = u16le(bytes[13], bytes[14]);
  data.pm2_5 = u16le(bytes[15], bytes[16]);
  data.pm10 = u16le(bytes[17], bytes[18]);
  data.time = decodeTime(bytes[3], bytes[4], bytes[5], bytes[6]);

  // Optional trailing battery-percentage byte.
  if (bytes.length > 19) {
    data.batteryPercent = bytes[19];
  }

  return { data: data };
}
