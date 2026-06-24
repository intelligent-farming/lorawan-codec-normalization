// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718E (Three-Axis Digital Accelerometer
// & NTC Thermistor — machine vibration / condition monitor), data report on
// fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718e.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports. bytes[1] is the device type
// (0x1C == 28 == R718E) and bytes[2] is the report-type discriminator:
//   0x00 -> device-info / startup frame (SW/HW version + datecode), no
//           measurement -> error.
//   0x01 -> acceleration report. bytes[3] is battery voltage in 0.1 V (high
//           bit flags low battery, surfaced as the camelCase extra
//           `lowBattery`). bytes[4..9] are three signed per-axis acceleration
//           values in g -> vibration.accelerationX/Y/Z. Each axis is a 16-bit
//           little-endian half-word decoded with the device's custom binary16
//           float (a 32-bit-layout sign/exponent/fraction split applied to a
//           16-bit value — replicated faithfully from upstream to reproduce
//           its exact output).
//   else (0x02) -> velocity report. bytes[3..8] are three per-axis velocity
//           values in mm/s -> vibration.velocityX/Y/Z (same custom float).
//           When bytes[1] == 0x1C, bytes[9..10] carry NTC temperature in 0.1 C
//           (16-bit big-endian, two's-complement) -> air.temperature. Velocity
//           reports carry no battery field.
// Config / threshold / restore responses (fPort 7) carry no measurement and
// are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Device "float32" decode applied to a 16-bit value: sign bit 15, exponent
// bits 14..7, fraction bits 6..0, biased like IEEE-754 binary32 (bias 127,
// 23-bit fraction field). This is the upstream wire encoding, replicated
// faithfully so per-axis magnitudes match the device's own console output.
function decodeAxisFloat(raw) {
  var sign = (raw & 0x8000) >> 15;
  var exp = (raw & 0x7f80) >> 7;
  var fraction = (raw & 0x007f) << 16;
  var value;
  if (exp === 0) {
    value = (sign ? -1 : 1) * Math.pow(2, -126) * (fraction / Math.pow(2, 23));
  } else if (exp === 0xff) {
    // Non-finite per the encoding; not a usable measurement.
    return null;
  } else {
    value = (sign ? -1 : 1) * Math.pow(2, exp - 127) * (1 + (fraction / Math.pow(2, 23)));
  }
  return round(value, 6);
}

function decodeTemperature(hi, lo) {
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return round(raw / 10, 1);
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};
  var vibration = {};

  if (reportType === 0x01) {
    // Acceleration report. Byte 3: battery voltage in 0.1 V; high bit flags
    // low battery.
    if (bytes[3] & 0x80) {
      data.lowBattery = true;
    }
    data.battery = round((bytes[3] & 0x7f) / 10, 1);

    vibration.accelerationX = decodeAxisFloat((bytes[5] << 8) | bytes[4]);
    vibration.accelerationY = decodeAxisFloat((bytes[7] << 8) | bytes[6]);
    vibration.accelerationZ = decodeAxisFloat((bytes[9] << 8) | bytes[8]);
  } else if (reportType === 0x02) {
    // Velocity report; no battery field on the wire.
    vibration.velocityX = decodeAxisFloat((bytes[4] << 8) | bytes[3]);
    vibration.velocityY = decodeAxisFloat((bytes[6] << 8) | bytes[5]);
    vibration.velocityZ = decodeAxisFloat((bytes[8] << 8) | bytes[7]);

    if (bytes[1] === 0x1c) {
      data.air = { temperature: decodeTemperature(bytes[9], bytes[10]) };
    }
  } else {
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no measurement'] };
  }

  data.vibration = vibration;
  return { data: data };
}
