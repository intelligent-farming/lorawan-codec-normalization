// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Browan TBSL100 (Sound Level Sensor).
// Data reports arrive on fPort 105.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/tbsl100.js, attributed in
// NOTICE). Normalization authored here; upstream decodeUplink is NOT copied.
//
// fPort 105 frame layout (4 bytes):
//   byte[0] bit0  status flag                          -> extra `status`
//   byte[1] low nibble  battery: (25 + nibble) / 10 V  -> battery (V)
//   byte[2] bits0..6    board temperature: value - 32 °C -> air.temperature (°C)
//   byte[3]             sound-pressure level in dB        -> sound.level (dB)
// The device reports a single averaged sound level (no separate peak), so
// sound.level satisfies the sound-level atLeastOne.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 105) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 105)'] };
  }
  if (!bytes || bytes.length < 4) {
    return { errors: ['expected 4 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data = {};

  // Sound-pressure level in dB.
  data.sound = { level: bytes[3] };

  // Battery voltage: 2.5 V base plus 0.1 V per low-nibble count.
  data.battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);

  // Board temperature (°C), offset by 32.
  data.air = { temperature: (bytes[2] & 0x7f) - 32 };

  // Status flag (device diagnostic).
  data.status = bytes[0] & 0x01;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "browan";
    result.data.model = "tbsl100";
  }
  return result;
}
