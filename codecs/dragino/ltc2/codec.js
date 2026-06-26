// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/ltc2 (Dragino LTC2-LB/LS 2-channel
// thermocouple temperature transmitter). Ported from the upstream Apache-2.0
// Dragino decoder (attributed in NOTICE), oracle-cross-checked.
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; b2 low nibble = external sensor
// type (0x01 = thermocouple). Channel 1 b3..4 signed/100 -> temperature;
// channel 2 b5..6 signed/100 -> temperature2 extra. 0x8001 marks an unconnected
// channel (omitted). Non-thermocouple Ext or no valid channel -> error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function nullCh(hi, lo) { return (hi & 0xff) === 0x80 && (lo & 0xff) === 0x01; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 7) { return { errors: ['payload too short (need >= 7 bytes)'] }; }
  if ((b[2] & 0x0f) !== 0x01) { return { errors: ['external sensor type ' + (b[2] & 0x0f) + ' is not the thermocouple mode'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  var have = false;
  if (!nullCh(b[3], b[4])) { data.temperature = round(s16(b[3], b[4]) / 100, 2); have = true; }
  if (!nullCh(b[5], b[6])) { data.temperature2 = round(s16(b[5], b[6]) / 100, 2); have = true; }
  if (!have) { return { errors: ['both thermocouple channels unconnected'] }; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "ltc2"; }
  return result;
}
