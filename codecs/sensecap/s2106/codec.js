// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for sensecap/s2106 (Seeed SenseCAP S2106 LoRaWAN pH
// sensor). Original work; wire format from the documented SenseCAP S210X
// measurement-ID protocol (attributed in NOTICE), cross-checked against an
// independent community decoder.
//
// Payload = one or more 7-byte telemetry frames + a trailing 2-byte CRC (not
// validated here). Each frame: b0 channel; b1..2 measurement ID (uint16 LE);
// b3..6 value (int32 LE, /1000). Measurement ID 4106 -> water.ph; the codec also
// maps the common SenseCAP IDs it may co-report (4097 air.temperature, 4098
// air.relativeHumidity, 4101 air.pressure Pa->hPa, 4108 soil.ec, 4109
// water.dissolvedOxygen, 4110 soil.moisture, 4102 soil.temperature); other
// measurement IDs become m<id> extras. Control frame ID 7 -> batteryPercent. A
// frame carrying no mappable measurement returns an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function i32le(b, k) {
  return (b[k] & 0xff) | ((b[k + 1] & 0xff) << 8) | ((b[k + 2] & 0xff) << 16) | ((b[k + 3] & 0xff) << 24);
}
function setPath(data, path, value) {
  var parts = path.split('.');
  var node = data;
  var i;
  for (i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]]) { node[parts[i]] = {}; }
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 9) { return { errors: ['payload too short for a SenseCAP frame (need >= 9 bytes)'] }; }
  if (((b.length - 2) % 7) !== 0) { return { errors: ['bad SenseCAP frame length ' + b.length + ' (expected 7*n + 2)'] }; }
  var idMap = {
    4097: 'air.temperature', 4098: 'air.relativeHumidity', 4102: 'soil.temperature',
    4106: 'water.ph', 4108: 'soil.ec', 4110: 'soil.moisture'
  };
  var data = {};
  var measured = false;
  var k;
  for (k = 0; k + 7 <= b.length - 2; k += 7) {
    var id = (b[k + 1] & 0xff) | ((b[k + 2] & 0xff) << 8);
    if (id > 4096) {
      var val = round(i32le(b, k + 3) / 1000, 3);
      if (id === 4101) { setPath(data, 'air.pressure', round(val / 100, 1)); measured = true; }
      else if (id === 4109) { setPath(data, 'water.dissolvedOxygen', val); measured = true; }
      else if (idMap[id]) { setPath(data, idMap[id], val); measured = true; }
      else { data['m' + id] = val; measured = true; }
    } else if (id === 7) {
      data.batteryPercent = ((b[k + 4] & 0xff) << 8) | (b[k + 3] & 0xff);
    }
  }
  if (!measured) { return { errors: ['no telemetry measurement in this frame (control-only)'] }; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "sensecap"; result.data.model = "s2106"; }
  return result;
}
