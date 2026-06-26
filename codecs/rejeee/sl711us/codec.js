// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for rejeee/sl711us (Rejeee SL711 LoRaWAN water-level
// sensor, 4-20 mA submersible probe, 0-5 m range). Original work; wire format
// from the documented Rejeee sensor-data protocol (SL711 User Manual section 4;
// attributed in NOTICE).
//
// fPort 1 FRMPayload (TLV sensor data): b0 0x00 device-info type; b1 high 3 bits
// version, low 5 bits battery level (0-31) -> batteryLevel extra; b2 reserve;
// b3 0x03 ADC type; b4..5 ADC unsigned big-endian (mV). Loop current = ADC mV x
// 0.01 (mA). The 4-20 mA span maps linearly to the 0-5 m level range:
// water.level = (mA - 4) / 16 * 5 (clamped to >= 0). The loop current is kept
// as the loopCurrent extra.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 6) { return { errors: ['payload too short (need >= 6 bytes)'] }; }
  if (b[0] !== 0x00) { return { errors: ['unexpected leading block 0x' + (b[0] & 0xff).toString(16) + ' (expected device-info 0x00)'] }; }
  if (b[3] !== 0x03) { return { errors: ['no ADC (0x03) sensor block in this frame'] }; }
  var mA = round(u16(b[4], b[5]) * 0.01, 3);
  var level = (mA - 4.0) / 16.0 * 5.0;
  if (level < 0) { level = 0; }
  var data = {};
  data.batteryLevel = b[1] & 0x1f;
  data.firmwareVersion = (b[1] >> 5) & 0x07;
  data.water = { level: round(level, 3) };
  data.loopCurrent = mA;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "rejeee"; result.data.model = "sl711us"; }
  return result;
}
