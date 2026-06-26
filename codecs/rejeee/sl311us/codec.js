// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for rejeee/sl311us (Rejeee SL311 / SL300-series
// LoRaWAN CO2 sensor with E-paper, embedded temperature & humidity). Original
// work; wire format from the documented Rejeee SL300/SL311 User Manual section 6
// (attributed in NOTICE), with CO2 cross-checked against the manual's decoder.
//
// fPort 1 FRMPayload (TLV sensor data): b0 0x00 device-info type; b1 high 3
// bits version, low 5 bits battery level (0-31) -> batteryLevel extra; b2
// reserve; then a sequence of TLV blocks. 0x04 temperature (2-byte signed,
// 0.1 C) -> air.temperature; 0x05 humidity (1 byte, %RH) -> air.relativeHumidity;
// 0x30 mixed-gas (length byte, gas-type byte, 4-byte big-endian value, unit
// 0.01): gas-type 0x04 = CO2 -> air.co2 (ppm). A frame with no CO2 block
// returns an error (the air-quality contract needs air.co2).
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function i32be(b, k) { return ((b[k] & 0xff) << 24) | ((b[k+1] & 0xff) << 16) | ((b[k+2] & 0xff) << 8) | (b[k+3] & 0xff); }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 3) { return { errors: ['payload too short (need >= 3 bytes)'] }; }
  if (b[0] !== 0x00) { return { errors: ['unexpected leading block 0x' + (b[0] & 0xff).toString(16) + ' (expected device-info 0x00)'] }; }
  var data = { air: {} };
  data.batteryLevel = b[1] & 0x1f;
  data.firmwareVersion = (b[1] >> 5) & 0x07;
  var haveCo2 = false;
  var o = 3;
  while (o < b.length) {
    var t = b[o++];
    if (t === 0x04) {
      if (o + 2 > b.length) { break; }
      data.air.temperature = round(s16(b[o], b[o + 1]) / 10, 1);
      o += 2;
    } else if (t === 0x05) {
      if (o + 1 > b.length) { break; }
      data.air.relativeHumidity = b[o] & 0xff;
      o += 1;
    } else if (t === 0x30) {
      if (o + 1 > b.length) { break; }
      var l = b[o++];
      if (o + l > b.length || l < 5) { break; }
      var gasType = b[o];
      var value = round(i32be(b, o + 1) / 100, 2);
      if (gasType === 0x04) { data.air.co2 = value; haveCo2 = true; }
      else { data['gas' + gasType] = value; }
      o += l;
    } else {
      break;
    }
  }
  if (!haveCo2) { return { errors: ['no CO2 (gas-type 0x04) block in this frame'] }; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "rejeee"; result.data.model = "sl311us"; }
  return result;
}
