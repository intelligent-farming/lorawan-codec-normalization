// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for milesight/em500-swl (Milesight EM500-SWL
// submersible water-level / depth sensor). Authored from the upstream
// Apache-2.0 Milesight decoder (attributed in NOTICE).
//
// Milesight TLV stream. Channel 0x01/0x75 battery (%) -> batteryPercent extra;
// channel 0x03/0x77 depth uint16LE (cm) -> water.level (m, /100). Sensor-error
// sentinels 0xFFFF (collection failed) and 0xFFFD (out of range) are reported
// as a depthError extra instead of a level. Version/status channels are
// skipped; a frame with no usable depth returns an error.

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
  var haveLevel = false;
  while (i < b.length) {
    var cid = b[i++];
    var ctype = b[i++];
    if (cid === 0x03 && ctype === 0x77) {
      var depthCm = u16le(b, i);
      i += 2;
      if (depthCm === 0xffff) { data.depthError = 'collection failed'; }
      else if (depthCm === 0xfffd) { data.depthError = 'out of range'; }
      else { data.water = { level: round(depthCm / 100, 2) }; haveLevel = true; }
    }
    else if (cid === 0xff && ctype === 0x1b) { i += 5; }
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
  if (!haveLevel) { return { errors: ['no valid depth measurement in this frame'] }; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "milesight"; result.data.model = "em500-swl"; }
  return result;
}
