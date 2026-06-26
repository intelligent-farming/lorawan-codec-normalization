// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lsn50v2-d20-d22-d23 (Dragino LSN50v2 with
// D20/D22/D23 external DS18B20 temperature probes). Ported from the upstream
// Apache-2.0 Dragino decoder (attributed in NOTICE), oracle-cross-checked.
//
// fPort 2, DS18B20 work mode (mode = (b6 & 0x7C) >> 2 == 3): battery
// (b0<<8|b1)/1000; probe "red" b2..3 signed/10 -> temperature; probe "white"
// b7..8 signed/10 -> temperature2 extra; b6 bit0 = alarm. 0xFFFF marks an
// unconnected probe (omitted). Other work modes -> error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function absent(hi, lo) { return (hi & 0xff) === 0xff && (lo & 0xff) === 0xff; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 9) { return { errors: ['payload too short (need >= 9 bytes)'] }; }
  if (((b[6] & 0x7c) >> 2) !== 3) { return { errors: ['work mode is not DS18B20 (mode 3)'] }; }
  var data = {};
  data.battery = round((((b[0] & 0xff) << 8) | b[1]) / 1000, 3);
  var have = false;
  if (!absent(b[2], b[3])) { data.temperature = round(s16(b[2], b[3]) / 10, 1); have = true; }
  if (!absent(b[7], b[8])) { data.temperature2 = round(s16(b[7], b[8]) / 10, 1); have = true; }
  if (!have) { return { errors: ['no probe connected'] }; }
  data.alarm = (b[6] & 0x01) ? true : false;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "lsn50v2-d20-d22-d23"; }
  return result;
}
