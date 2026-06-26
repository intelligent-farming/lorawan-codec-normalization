// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for milesight/em500-pp (Milesight EM500-PP gauge
// pressure transmitter). Authored from the upstream Apache-2.0 Milesight
// decoder (attributed in NOTICE).
//
// Milesight TLV stream. Channel 0x01/0x75 battery (%) -> batteryPercent extra;
// channel 0x03/0x7B pressure int16LE (kPa, no scaling) -> pressure.gauge (kPa).
// Version/status channels are skipped. A frame with no pressure measurement
// (config/version-only) cannot satisfy process-pressure and returns an error.

// Milesight TLV channel/type stream. The version/status channels are fixed-width
// and surfaced as camelCase extras; the measurement channel(s) map to the
// vocabulary. Battery is a percentage (-> batteryPercent extra; vocabulary
// battery is volts). A faithful port of the Milesight channel layout.
function u16le(b, i) { return ((b[i + 1] & 0xff) << 8) | (b[i] & 0xff); }
function i16le(b, i) { var v = u16le(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || !b.length) { return { errors: ['empty payload'] }; }
  var data = {};
  var i = 0;
  var havePressure = false;
  while (i < b.length) {
    var cid = b[i++];
    var ctype = b[i++];
    if (cid === 0x03 && ctype === 0x7b) {
      data.pressure = { gauge: i16le(b, i) };
      havePressure = true;
      i += 2;
    }
    if (cid === 0xff && ctype === 0x01) { i += 1; }
    else if (cid === 0xff && ctype === 0x09) { i += 2; }
    else if (cid === 0xff && ctype === 0x0a) { i += 2; }
    else if (cid === 0xff && ctype === 0xff) { i += 2; }
    else if (cid === 0xff && ctype === 0x16) { i += 8; }
    else if (cid === 0xff && ctype === 0x0f) { i += 1; }
    else if (cid === 0xff && ctype === 0xfe) { i += 1; }
    else if (cid === 0xff && ctype === 0x0b) { i += 1; }
    else if (cid === 0x01 && ctype === 0x75) { data.batteryPercent = b[i] & 0xff; i += 1; }
    else { break; }
  }
  if (!havePressure) { return { errors: ['no pressure measurement in this frame (config/version-only)'] }; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "milesight"; result.data.model = "em500-pp"; }
  return result;
}
