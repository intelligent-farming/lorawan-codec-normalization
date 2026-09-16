// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lsn50v2-d20-d22-d23 (Dragino LSN50v2 with
// D20/D22/D23 external DS18B20 temperature probes). Ported from the upstream
// Apache-2.0 Dragino decoder (attributed in NOTICE), oracle-cross-checked.
//
// fPort 2, DS18B20 work mode (mode = (b6 & 0x7C) >> 2 == 3): battery
// (b0<<8|b1)/1000; b6 bit0 = alarm. The frame carries THREE external DS18B20
// probe words, all signed/10 °C: b2..3, b7..8 and b9..10. Other work modes ->
// error.
//
// Each probe is the same quantity at a different sub-sensor position, so each
// rides in the reserved `channels` array (see AUTHORING.md "Multi-channel
// devices") instead of the old `temperature` + `temperature2` suffixed pair.
// Label scheme — the vendor's own term for the position: Dragino names these
// probes by the pigtail wire colour and its decoder/field names fix the mapping
// (Temp_Red = b2..3, Temp_White = b7..8, Temp_Black = b9..10), so the labels are
// `probeRed`, `probeWhite` and `probeBlack`. The colour is a *more* stable
// positional identifier than an index here, because it is printed on the
// physical cable and does not shift between the D20 (1 probe), D22 (2 probes)
// and D23 (3 probes) variants this one codec covers — AUTHORING allows the
// physical position when the datasheet fixes it. Each entry carries the
// `temperature` vocabulary key in °C with the same scaling and 1-decimal
// rounding as before. `battery` and the `alarm` flag are whole-device readings
// and stay top-level; no leaf is emitted in both places.
//
// The third (black) probe was previously dropped altogether; it is now decoded
// as its own entry, matching the upstream oracle (whose TTN example reports
// Temp_Black 51.7 from b9..10).
//
// Sentinel policy: this frame DOES define a per-probe disconnected sentinel —
// the raw word 0xFFFF (upstream reports it as the string 'NULL'). A probe
// reading 0xFFFF is not attached, so its entry is skipped rather than decoded as
// -0.1 °C; that is also how a D20 or D22 (fewer than three probes) presents its
// unpopulated positions. If NO probe is present the frame is rejected with the
// unchanged error 'no probe connected' (so `channels` is never emitted empty).
// One further omission is structural, not sentinel-driven: a frame truncated
// before b9..10 carries no black-probe word, so `probeBlack` gets no entry
// rather than a fabricated reading.
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
  var probes = [];
  if (!absent(b[2], b[3])) { probes.push({ channel: 'probeRed', temperature: round(s16(b[2], b[3]) / 10, 1) }); }
  if (!absent(b[7], b[8])) { probes.push({ channel: 'probeWhite', temperature: round(s16(b[7], b[8]) / 10, 1) }); }
  if (b.length >= 11 && !absent(b[9], b[10])) { probes.push({ channel: 'probeBlack', temperature: round(s16(b[9], b[10]) / 10, 1) }); }
  if (probes.length === 0) { return { errors: ['no probe connected'] }; }
  data.channels = probes;
  data.alarm = (b[6] & 0x01) ? true : false;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "lsn50v2-d20-d22-d23" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "lsn50v2-d20-d22-d23"; }
  return result;
}
