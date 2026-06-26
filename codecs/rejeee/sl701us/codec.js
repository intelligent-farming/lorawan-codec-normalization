// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for rejeee/sl701us (Rejeee SL701 LoRaWAN pressure
// transmitter). Original work; wire format from the documented Rejeee sensor-
// data protocol (SL700/SL701 User Manual section 4; attributed in NOTICE),
// which shares the Rejeee Pressure TLV (0x07).
//
// fPort 1 FRMPayload (TLV sensor data): b0 0x00 device-info type; b1 high 3
// bits version, low 5 bits battery level (0-31) -> batteryLevel extra; b2
// reserve; b3 0x07 pressure type; b4..7 pressure (4-byte signed integer, Pa).
// Process gauge pressure Pa -> pressure.gauge (kPa, /1000). A frame without the
// 0x07 pressure block returns an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function i32be(b, k) {
  return ((b[k] & 0xff) << 24) | ((b[k + 1] & 0xff) << 16) | ((b[k + 2] & 0xff) << 8) | (b[k + 3] & 0xff);
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 8) { return { errors: ['payload too short (need >= 8 bytes)'] }; }
  if (b[0] !== 0x00) { return { errors: ['unexpected leading block 0x' + (b[0] & 0xff).toString(16) + ' (expected device-info 0x00)'] }; }
  if (b[3] !== 0x07) { return { errors: ['no pressure (0x07) sensor block in this frame'] }; }
  var pa = i32be(b, 4);
  var data = {};
  data.batteryLevel = b[1] & 0x1f;
  data.firmwareVersion = (b[1] >> 5) & 0x07;
  data.pressure = { gauge: round(pa / 1000, 3) };
  data.pressurePa = pa;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "rejeee"; result.data.model = "sl701us"; }
  return result;
}
