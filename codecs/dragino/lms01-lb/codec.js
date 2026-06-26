// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lms01-lb (Dragino LMS01-LB/LS leaf
// moisture + leaf temperature sensor). Authored from the upstream Apache-2.0
// Dragino decoder (attributed in NOTICE; upstream stores JS with escaped newlines).
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; DS18B20 probe temp b2..3 signed/10
// (extra); leaf moisture b4..5 /10 (%) -> leaf.wetness; leaf temperature b6..7
// signed/10 -> leaf.temperature; interrupt flag b8, message type b10 -> extras.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 11) { return { errors: ['payload too short (need >= 11 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.probeTemperature = round(s16(b[2], b[3]) / 10, 2);
  data.leaf = { wetness: round((((b[4] & 0xff) << 8) | b[5]) / 10, 2), temperature: round(s16(b[6], b[7]) / 10, 2) };
  data.interruptFlag = b[8];
  data.messageType = b[10];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "lms01-lb"; }
  return result;
}
