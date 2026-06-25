// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for makerfabs/none-position-rope-water-leak (Makerfabs rope/cable water-leak
// detector: battery, leak flag, leak count and cumulative leak time).
//
// Wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/none-position-rope-water-leak.js, attributed in
// NOTICE), which emits generic field1..4. The normalization here is authored:
// the leak flag (1 = leak) -> water.leak.

function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 10) { return { errors: ['payload too short (need >= 10 bytes)'] }; }
  return { data: {
    battery: round(b[2] / 10, 1),
    water: { leak: b[3] === 1 },
    waterLeakCount: b[4] * 256 + b[5],
    waterLeakTime: b[6] * 16777216 + b[7] * 65536 + b[8] * 256 + b[9]
  } };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "none-position-rope-water-leak";
  }
  return result;
}
