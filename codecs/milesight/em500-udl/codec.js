// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for milesight/em500-udl (Milesight EM500-UDL Ultrasonic Distance/Level Sensor). Authored
// from the upstream Apache-2.0 Milesight decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em500-udl.js, attributed in NOTICE), cross-checked against it.
//
// Milesight TLV stream. Channel 0x01/0x75 battery (%) -> batteryPercent; channel
// 0x03/0x82 distance uint16LE (mm) -> tank.distance (m, /1000); version/status
// channels skipped. A top-mounted ranging sensor -> tank-level. A frame with no
// distance returns an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function u16le(b, i) { return ((b[i + 1] & 0xff) << 8) | (b[i] & 0xff); }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || !b.length) { return { errors: ['empty payload'] }; }
  var data = {};
  var i = 0;
  var have = false;
  while (i < b.length) {
    var cid = b[i++];
    var ctype = b[i++];
    if (cid === 0x03 && ctype === 0x82) { data.tank = { distance: round(u16le(b, i) / 1000, 3) }; have = true; i += 2; }
    else if (cid === 0x01 && ctype === 0x75) { data.batteryPercent = b[i] & 0xff; i += 1; }
    else if (cid === 0xff && ctype === 0x01) { i += 1; }
    else if (cid === 0xff && ctype === 0x09) { i += 2; }
    else if (cid === 0xff && ctype === 0x0a) { i += 2; }
    else if (cid === 0xff && ctype === 0xff) { i += 2; }
    else if (cid === 0xff && ctype === 0x16) { i += 8; }
    else if (cid === 0xff && ctype === 0x0b) { i += 1; }
    else if (cid === 0xff && ctype === 0x0f) { i += 1; }
    else { break; }
  }
  if (!have) { return { errors: ['no distance measurement in this frame'] }; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "milesight", model: "em500-udl" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "milesight"; result.data.model = "em500-udl"; }
  return result;
}
