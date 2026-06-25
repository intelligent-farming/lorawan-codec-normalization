// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for makerfabs/gps-tracker-neo-6m (Makerfabs NEO-6M
// GPS tracker: battery, GPS fix, and a G-sensor state byte).
//
// Wire format (byte offsets, /100000 lat-lon scaling) understood from the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/makerfabs/gps-tracker-neo-6m.js, attributed in NOTICE), which emits
// generic field1..4. The normalization here is authored. Upstream computes the
// hemisphere from the (always-positive) magnitude, so it can never report S/W;
// this codec instead applies the hemisphere bytes (bytes[16] N/S, bytes[21]
// E/W) for a correct signed latitude/longitude.

function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 22) { return { errors: ['payload too short (need >= 22 bytes)'] }; }
  var data = { battery: round(b[2] / 10, 1), gSensorState: b[3] };
  var gpsStatus = b[4];
  if (gpsStatus !== 0) {
    var lat = (b[12] * 16777216 + b[13] * 65536 + b[14] * 256 + b[15]) / 100000;
    if (b[16] !== 0) { lat = -lat; }
    var lon = (b[17] * 16777216 + b[18] * 65536 + b[19] * 256 + b[20]) / 100000;
    if (b[21] !== 0) { lon = -lon; }
    data.position = { latitude: round(lat, 5), longitude: round(lon, 5) };
  } else {
    data.gpsFix = false;
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "gps-tracker-neo-6m";
  }
  return result;
}
