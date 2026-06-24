// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Browan CD10 (Tabs CO2 Display / MerryIoT Air
// Quality CO2 — CO2, temperature & humidity display), data uplink on fPort 127.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/cd10.js, attributed in
// NOTICE). Ported from that upstream decodeUplink; the normalization here is
// authored for this module — do NOT treat upstream normalization as our output.
//
// Mapping from the upstream decode:
//   co2_ppm     -> air.co2 (ppm)
//   temperature -> air.temperature (°C, raw little-endian /10)
//   humidity    -> air.relativeHumidity (%)
//   battery     -> battery (volts): (21 + (byte1 & 0x0f)) / 10 = 2.1 V .. 3.6 V
//   status / button / co2threshold / co2calibration -> camelCase extras
//
// Upstream returns the raw 16-bit little-endian temperature divided by 10
// without sign handling; this port preserves that behaviour faithfully (the
// upstream decoder is the source of truth for the wire format).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 127) {
    return { errors: ['unknown FPort'] };
  }

  if (bytes.length < 7) {
    return { errors: ['expected at least 7 bytes, got ' + bytes.length] };
  }

  var data = {};
  var air = {};

  // Byte 1 low nibble: battery, 2.1 V + 0.1 V steps.
  data.battery = round((21 + (bytes[1] & 0x0f)) / 10, 1);

  // Bytes 2-3 LE: temperature, raw value / 10 (°C).
  air.temperature = round(u16le(bytes[2], bytes[3]) / 10, 1);

  // Byte 4: relative humidity (%).
  air.relativeHumidity = bytes[4];

  // Bytes 5-6 LE: CO2 concentration (ppm).
  air.co2 = u16le(bytes[5], bytes[6]);

  data.air = air;

  // Byte 0: status flags (device-specific camelCase extras).
  data.status = bytes[0] & 0x01;
  data.button = (bytes[0] >> 1) & 0x01;
  data.co2Threshold = (bytes[0] >> 4) & 0x01;
  data.co2Calibration = (bytes[0] >> 5) & 0x01;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "browan";
    result.data.model = "cd10";
  }
  return result;
}
