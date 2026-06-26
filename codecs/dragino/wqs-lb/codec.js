// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/wqs-lb (Dragino WQS-LB/WQS-LS water-
// quality sensor transmitter; multi-probe). Ported from the upstream Apache-2.0
// Dragino decoder (TheThingsNetwork/lorawan-devices vendor/dragino/wqs-lb.js,
// attributed in NOTICE; upstream stores JS with escaped newlines).
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; DS18B20 water temperature b2..3
// signed/10 -> water.temperature.current; b4 = interrupt flag (bit7) + a 6-bit
// probe-present mask (bits 5..0). Present probes follow from byte 5 in mask
// order: bit5 turbidity (/10) -> water.turbidity (NTU); bit4 dissolved oxygen
// (/100) -> water.dissolvedOxygen (mg/L); bit3 ORP (signed) -> water.orp (mV);
// bit2 EC K=10 (x10) and bit1 EC K=1 -> water.ec (µS/cm); bit0 pH (/100) ->
// water.ph. fPort 3 datalog history and fPort 5 device-info -> error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 3) { return { errors: ['datalog history frame (fPort 3), not a live measurement'] }; }
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 5) { return { errors: ['payload too short (need >= 5 bytes)'] }; }
  var data = { water: {} };
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.water.temperature = { current: round(s16(b[2], b[3]) / 10, 2) };
  data.interruptFlag = (b[4] >> 7) & 0x01;
  var mask = b[4] & 0x3f;
  var j = 5;
  if ((mask >> 5) & 0x01) { data.water.turbidity = round((((b[j] & 0xff) << 8) | b[j + 1]) / 10, 2); j += 2; }
  if ((mask >> 4) & 0x01) { data.water.dissolvedOxygen = round((((b[j] & 0xff) << 8) | b[j + 1]) / 100, 2); j += 2; }
  if ((mask >> 3) & 0x01) { data.water.orp = s16(b[j], b[j + 1]); j += 2; }
  if ((mask >> 2) & 0x01) { data.water.ec = (((b[j] & 0xff) << 8) | b[j + 1]) * 10; j += 2; }
  if ((mask >> 1) & 0x01) { data.water.ec = ((b[j] & 0xff) << 8) | b[j + 1]; j += 2; }
  if (mask & 0x01) { data.water.ph = round((((b[j] & 0xff) << 8) | b[j + 1]) / 100, 2); j += 2; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "wqs-lb"; }
  return result;
}
