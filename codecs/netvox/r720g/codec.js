// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R720G (Wireless GPS Tracker with tilt
// angle), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r720g.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports. bytes[0] is the frame version,
// bytes[1] the device type (0xB5 == 181 == R720G) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`).
//
// The R720G splits its GNSS fix across two report types:
//   reportType 0x01 -> latitude (bytes[4..7], signed degrees * 1e6) plus the
//                      tilt angles X/Y/Z (bytes[8..10], signed degrees) ->
//                      position.latitude + camelCase extras angleX/angleY/angleZ
//   reportType 0x02 -> longitude (bytes[4..7], signed degrees * 1e6) plus the
//                      horizontal dilution of precision (bytes[8]) and GPS
//                      altitude (bytes[9..10], signed metres) ->
//                      position.longitude + camelCase extras hdop/altitude
// So a single uplink carries either latitude OR longitude, never both; a
// complete position is reconstructed downstream by pairing consecutive reports.
//
// A latitude/longitude field of 0xFFFFFFFF and an altitude of 0xFFFF are the
// device's "no valid GPS fix" sentinels; a coordinate sentinel means the frame
// carries no position measurement and is reported as an error, while a sentinel
// altitude is simply omitted. Config responses (fPort 7) carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// 32-bit big-endian signed degrees * 1e6 -> decimal degrees. Mirrors the
// upstream `(b0<<24 | b1<<16 | b2<<8 | b3) / 1000000`, where the leading <<24
// makes the value two's-complement signed.
function decodeCoordinate(b0, b1, b2, b3) {
  var raw = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
  return round(raw / 1000000, 6);
}

// 8-bit two's-complement signed angle in degrees.
function decodeAngle(b) {
  if (b & 0x80) {
    return (0x100 - b) * -1;
  }
  return b;
}

// 16-bit big-endian two's-complement signed altitude in metres.
function decodeAltitude(hi, lo) {
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return raw;
}

function isNoFix(b0, b1, b2, b3) {
  return b0 === 0xff && b1 === 0xff && b2 === 0xff && b3 === 0xff;
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

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  if (reportType === 0x01) {
    // Latitude report.
    if (isNoFix(bytes[4], bytes[5], bytes[6], bytes[7])) {
      return { errors: ['no GPS fix (latitude unavailable)'] };
    }
    data.position = {
      latitude: decodeCoordinate(bytes[4], bytes[5], bytes[6], bytes[7])
    };
    data.angleX = decodeAngle(bytes[8]);
    data.angleY = decodeAngle(bytes[9]);
    data.angleZ = decodeAngle(bytes[10]);
  } else if (reportType === 0x02) {
    // Longitude report.
    if (isNoFix(bytes[4], bytes[5], bytes[6], bytes[7])) {
      return { errors: ['no GPS fix (longitude unavailable)'] };
    }
    data.position = {
      longitude: decodeCoordinate(bytes[4], bytes[5], bytes[6], bytes[7])
    };
    data.hdop = bytes[8];
    if (!(bytes[9] === 0xff && bytes[10] === 0xff)) {
      data.altitude = decodeAltitude(bytes[9], bytes[10]);
    }
  } else {
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no measurement'] };
  }

  return { data: data };
}
