// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DC600 (LoRaWAN water-leakage sensor
// with four independent leak-detection channels — typically four rope/spot
// probes — plus device temperature, a low-battery flag and a monitoring-enabled
// status flag).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/dc600.js, attributed in
// NOTICE). The upstream field extraction (fixed byte offsets; status nibbles)
// is reproduced faithfully; only the JSON shape is re-authored to the
// normalized vocabulary (never the upstream output object).
//
// All uplinks arrive on FPort 3. The 4th byte (bytes[3]) selects the layout:
//   17 bytes, bytes[3] != 0x03   Heartbeat / leak report (a measurement).
//   17 bytes, bytes[3] == 0x03   Parameter report (firmware / interval / battery
//                                threshold / monitor flag) — device settings,
//                                not a measurement, reported as an error.
//
// Status-byte semantics (faithful to upstream):
//   bytes[11] bit0  monitor-enabled flag. Upstream reads `!Boolean(b & 0x01)`,
//                   i.e. a SET bit means monitoring is OFF; a clear bit means ON.
//   bytes[12] bits 0x10/0x20/0x40/0x80  per-channel leak ALARM (channels 1-4).
//                   These are active-LOW: upstream reads `!Boolean(b & mask)`, so
//                   a CLEAR bit means that channel is alarming (leak detected).
//   bytes[12] low nibble (0x0f)  low-battery alarm flag (active-high).
//   bytes[8]  device temperature, whole degrees C.
//   bytes[13..14]  16-bit big-endian frame counter.
//
// Multi-channel shape (`channels[]`) — the four leak inputs are sub-sensor
// positions of one device reporting the same quantity, so each rides in the
// reserved `channels` array (see AUTHORING.md "Multi-channel devices") instead
// of the suffixed `leakChannel1`..`leakChannel4` extras this codec used to
// emit. One entry per input, each carrying the `water.leak` vocabulary boolean.
//
// Label scheme — the vendor's own term is "channel": both the upstream decoder
// (`alarmChannel1`..`alarmChannel4`) and the Dingtek DC600 product sheet call
// each rope/spot-probe input a *channel*, so the entry labels keep that term
// with a zero-based index rather than inventing a `probe`/`input` word the
// device never uses. The labels are zero-based while Dingtek's own numbering is
// one-based, so the renumbering is:
//   `channel0` = Dingtek channel 1 = bytes[12] & 0x10 = old `leakChannel1`
//   `channel1` = Dingtek channel 2 = bytes[12] & 0x20 = old `leakChannel2`
//   `channel2` = Dingtek channel 3 = bytes[12] & 0x40 = old `leakChannel3`
//   `channel3` = Dingtek channel 4 = bytes[12] & 0x80 = old `leakChannel4`
// (The entry *label key* is spelled `channel` by the reserved-array contract, so
// an entry reads `{ channel: "channel0", … }`; the repetition is the price of
// using the vendor's real word for the position.)
//
// Aggregate policy — the old top-level `water.leak` was the any-channel OR of
// the four inputs. It is REMOVED: each entry now carries its own `water.leak`
// (per-position truth), and AUTHORING forbids emitting the same leaf both
// top-level and inside entries — downstream stores keep top-level readings
// under the empty channel label and would double-count the leak metric. A
// consumer wanting the whole-device alarm ORs the entries. The `water-leak`
// category (requires `water.leak`) is still satisfied: membership resolves
// through top-level `channels[]` entries.
//
// `water.temperature.current` is a WHOLE-DEVICE reading and stays TOP-LEVEL: it
// is a single sensor, not one per channel. Upstream extracts exactly one
// temperature byte for the whole frame (`temperature: input.bytes[8]`) and the
// 17-byte layout carries no per-channel temperature field, so copying it into
// each entry would fabricate four readings from one and (worse) would put the
// same leaf both top-level and in entries. It is a different leaf from the
// entries' `water.leak`, so nothing is double-counted. `monitorEnabled`,
// `batteryLow` and `frameCounter` are likewise whole-device and stay top-level.
//
// Sentinel policy: this frame format defines NO disconnected-channel sentinel.
// Each of the four alarm bits is a plain boolean (upstream reads it with a
// two-way `!Boolean(bytes[12] & mask)` test) and neither upstream nor the
// 17-byte layout reserves a third "channel not fitted / probe unplugged" value,
// so an unwired channel is indistinguishable from a dry one: no value is
// treated as a sentinel and no channel entry is ever suppressed on its reading.
// Nor can a short frame fabricate a dry channel from `undefined` — the length
// guard below requires exactly 17 bytes, so bytes[12] is always present when a
// frame decodes. `channels` is therefore built only on the measurement path and
// always carries all four entries there; a parameter report returns an error and
// emits no `channels` key at all.
//
// Field mapping:
//   per-channel alarm flags        -> channels[] entries `channel0`..`channel3`,
//                                    each with water.leak (true = leak detected)
//   temperature (°C)               -> water.temperature.current (top level)
//   monitor-enabled flag           -> monitorEnabled (boolean extra)
//   low-battery flag               -> batteryLow (boolean extra; NOT vocabulary
//                                    `battery`, which is volts — the device only
//                                    reports a threshold flag, not a voltage)
//   frame counter                  -> frameCounter (extra)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (bytes.length !== 17) {
    return { errors: ['wrong length (expected 17 bytes)'] };
  }
  if (bytes[3] === 0x03) {
    // Parameter report — device settings, not a normalized measurement.
    return { errors: ['parameter report frame carries no normalized measurement'] };
  }

  var data = {
    water: {
      temperature: { current: round(bytes[8], 0) }
    },
    monitorEnabled: !Boolean(bytes[11] & 0x01),
    batteryLow: Boolean(bytes[12] & 0x0f),
    frameCounter: (bytes[13] << 8) + bytes[14]
  };

  // One channels[] entry per leak-detection channel. Per-channel leak alarms
  // are active-LOW (a CLEAR status bit = leak), exactly as upstream reads them.
  var masks = [0x10, 0x20, 0x40, 0x80];
  var channels = [];
  for (var i = 0; i < masks.length; i += 1) {
    channels.push({
      channel: 'channel' + i,
      water: { leak: !Boolean(bytes[12] & masks[i]) }
    });
  }
  if (channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dingtek", model: "dc600" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "dc600";
  }
  return result;
}
