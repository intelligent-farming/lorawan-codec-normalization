// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for terabee/lora-lm-xl (Terabee LoRa Level Monitoring
// XL, ToF). Authored from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/terabee/lora-lm-xl.js, attributed in
// NOTICE), cross-checked as oracle.
//
// 6-byte frame: b0..1 distance to surface (mm; 0=too close, 1=invalid,
// 0xFFFF=too far) -> tank.distance (m); b2 fill level (%, 255=error) ->
// tank.level; b3..4 battery (mV) -> battery (V); b5 error flags -> error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 6) { return { errors: ['payload too short (need >= 6 bytes)'] }; }
  if (b[5] !== 0) { return { errors: ['device-reported error flags: 0x' + (b[5] & 0xff).toString(16)] }; }
  var distMm = ((b[0] & 0xff) << 8) | b[1];
  var level = b[2] & 0xff;
  var data = {};
  var have = false;
  if (distMm !== 0 && distMm !== 1 && distMm !== 0xffff) { data.tank = { distance: round(distMm / 1000, 3) }; have = true; }
  if (level !== 255) { data.tank = data.tank || {}; data.tank.level = level; have = true; }
  if (!have) { return { errors: ['no valid distance or level in this frame'] }; }
  data.battery = round((((b[3] & 0xff) << 8) | b[4]) / 1000, 3);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "terabee", model: "lora-lm-xl" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "terabee"; result.data.model = "lora-lm-xl"; }
  return result;
}
