// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox RA07W (Wireless Water Leak Detection and
// Location Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/ra07w.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries device reports: bytes[0] is the frame version, bytes[1] the
// 1-byte device type (0x0C == 12 == RA07W) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement -> error. For a status
// frame (reportType non-zero), bytes[3] is battery voltage in 0.1 V (high bit
// flags low battery, surfaced as the camelCase extra `lowBattery`) -> battery
// (V), and bytes[4..5] are the leak location as a 16-bit big-endian value scaled
// x10 -> the camelCase extra `leakLocation`.
//
// The RA07W is a rope/cable leak-locating sensor: it does not emit a standalone
// leak boolean. Instead it reports the position along the 4-core positioning
// sensor line where a leak was detected. A non-zero location means a leak was
// detected at that point; a location of 0 means no leak. We derive the required
// boolean water.leak from that signal (leakLocation > 0). Config responses
// (fPort 7) carry no measurement -> error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
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

  // Bytes 4-5: leak location, 16-bit big-endian, scaled x10. Non-zero == leak
  // detected at that distance along the positioning line; 0 == no leak.
  var leakLocation = ((bytes[4] << 8) | bytes[5]) * 10;
  data.leakLocation = leakLocation;

  data.water = {
    leak: leakLocation > 0
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "ra07w";
  }
  return result;
}
