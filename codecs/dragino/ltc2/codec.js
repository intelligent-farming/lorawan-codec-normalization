// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/ltc2 (Dragino LTC2-LB/LS 2-channel
// thermocouple temperature transmitter). Ported from the upstream Apache-2.0
// Dragino decoder (attributed in NOTICE), oracle-cross-checked.
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; b2 low nibble = external sensor
// type (0x01 = thermocouple). Two thermocouple inputs: b3..4 signed/100 and
// b5..6 signed/100, both °C. Non-thermocouple Ext or no connected channel ->
// error.
//
// Both inputs are the same quantity at two sub-sensor positions, so each rides
// in the reserved `channels` array (see AUTHORING.md "Multi-channel devices")
// instead of the old `temperature` + `temperature2` suffixed pair. Labels are
// the vendor's own term plus a zero-based index: Dragino documents these as
// channel 1 (b3..4) and channel 2 (b5..6), which map to `channel0` and
// `channel1` respectively. Each entry carries the `temperature` vocabulary key
// in °C with the same scaling and 2-decimal rounding as before. `battery` is a
// whole-device reading and stays top-level; no leaf is emitted in both places.
//
// Sentinel policy: this frame DOES define a per-channel disconnected sentinel —
// the raw word 0x8001 (upstream reports it as the string 'NULL'). A channel
// reading 0x8001 has no thermocouple attached, so its entry is skipped rather
// than decoded as -327.67 °C. If BOTH channels read the sentinel there is no
// measurement at all and the frame is rejected with the unchanged error
// 'both thermocouple channels unconnected' (so `channels` is never emitted
// empty).
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
  var channels = [];
  if (!nullCh(b[3], b[4])) { channels.push({ channel: 'channel0', temperature: round(s16(b[3], b[4]) / 100, 2) }); }
  if (!nullCh(b[5], b[6])) { channels.push({ channel: 'channel1', temperature: round(s16(b[5], b[6]) / 100, 2) }); }
  if (channels.length === 0) { return { errors: ['both thermocouple channels unconnected'] }; }
  data.channels = channels;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "ltc2" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "ltc2"; }
  return result;
}
