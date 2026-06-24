// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311W (Wireless Water Leak Sensor),
// data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r311w.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports. bytes[0] is the frame version,
// bytes[1] the device type (0x06 == 6 == R311W) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement, reported as an
// error. For a measurement frame, bytes[3] is battery voltage in 0.1 V (high
// bit flags low battery, surfaced as the camelCase extra `lowBattery`).
//
// The R311W is a two-probe leak detector: bytes[4] is leak status for probe 1
// and bytes[5] for probe 2 (0x00 == no leak, non-zero == leak). The normalized
// water.leak is the OR of both probes (true if any probe is wet); the
// individual probe states are preserved as the camelCase extras `leak1` and
// `leak2`. Config responses (fPort 7) carry no measurement and are reported as
// errors.

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

  // Bytes 4-5: per-probe leak status (0x00 == no leak, non-zero == leak).
  var leak1 = bytes[4] !== 0x00;
  var leak2 = bytes[5] !== 0x00;

  data.water = {
    leak: leak1 || leak2
  };
  data.leak1 = leak1;
  data.leak2 = leak2;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r311w";
  }
  return result;
}
