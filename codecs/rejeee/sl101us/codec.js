// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for rejeee/sl101us (Rejeee SL101US Temperature & Humidity Sensor). Original work;
// wire format from the documented Rejeee LoRaWAN sensor-data protocol (SL711
// User Manual section 4; attributed in NOTICE), cross-checked against an
// independent community decoder.
//
// fPort 1 FRMPayload (TLV sensor data): b0 0x00 device-info type; b1 high 3
// bits firmware version, low 5 bits battery level (0-31) -> batteryLevel extra;
// b2 reserve; b3 temperature TLV type; b4..5 temperature signed/10 ->
// air.temperature; b6 humidity TLV type; b7 humidity (%) ->
// air.relativeHumidity. Frames shorter than 8 bytes return an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 8) { return { errors: ['payload too short (need >= 8 bytes)'] }; }
  if (b[0] !== 0x00) { return { errors: ['unexpected leading block 0x' + (b[0] & 0xff).toString(16) + ' (expected device-info 0x00)'] }; }
  var data = {};
  data.batteryLevel = b[1] & 0x1f;
  data.firmwareVersion = (b[1] >> 5) & 0x07;
  data.air = { temperature: round(s16(b[4], b[5]) / 10, 1), relativeHumidity: b[7] & 0xff };
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "rejeee"; result.data.model = "sl101us"; }
  return result;
}
