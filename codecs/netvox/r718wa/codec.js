// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718WA (Wireless Water Leak Sensor),
// data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r311w.js, the shared
// family decoder that also handles deviceType 50 = R718WA; attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic reports. bytes[0] is the protocol version, bytes[1]
// the device type (50 = R718WA), bytes[2] the report-type discriminator. Report
// type 0x00 is the device-info / startup frame and carries no measurement. The
// status report carries: battery (bytes[3], volts at 0.1 V resolution, high bit
// flags low battery -> surfaced as the camelCase extra `lowBattery`) and the
// single water-leak probe state (bytes[4], non-zero = leak detected ->
// water.leak boolean). The R718WA is a single-probe sensor and reports no
// temperature. Config frames (fPort 7) carry no measurement and are errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 5) {
    return { errors: ['expected at least 5 bytes, got ' + bytes.length] };
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

  // Byte 4: water-leak probe state, non-zero = leak detected.
  data.water = { leak: bytes[4] ? true : false };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718wa";
  }
  return result;
}
