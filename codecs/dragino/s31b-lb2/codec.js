// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/s31b-lb2 (Dragino S31B-family
// temperature & humidity sensor, SHT31 element). Authored from the upstream
// Apache-2.0 Dragino S31B decoder (attributed in NOTICE).
//
// fPort 2: work mode is (b6 & 0x7C) >> 2. In the normal SHT mode (mode 0):
// battery (b0<<8|b1)/1000; b2..5 are a device timestamp (surfaced as the
// epochSeconds extra); SHT31 temperature b7..8 signed/10 -> air.temperature;
// SHT31 humidity b9..10 /10 -> air.relativeHumidity. Mode 31 is a min/max
// statistics frame and mode != 0 cannot satisfy the climate contract, so it is
// reported as an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 3) { return { errors: ['datalog history frame (fPort 3), not a live measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 11) { return { errors: ['payload too short (need >= 11 bytes)'] }; }
  var mode = (b[6] & 0x7c) >> 2;
  if (mode !== 0) { return { errors: ['work mode ' + mode + ' is not the SHT climate mode'] }; }
  var data = {};
  data.battery = round((((b[0] & 0xff) << 8) | b[1]) / 1000, 3);
  data.air = { temperature: round(s16(b[7], b[8]) / 10, 1), relativeHumidity: round((((b[9] & 0xff) << 8) | b[10]) / 10, 1) };
  data.epochSeconds = (b[2] * 16777216) + ((b[3] & 0xff) << 16) + ((b[4] & 0xff) << 8) + (b[5] & 0xff);
  data.extiTriggered = (b[6] & 0x01) ? true : false;
  data.doorClosed = (b[6] & 0x80) ? true : false;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "s31b-lb2"; }
  return result;
}
