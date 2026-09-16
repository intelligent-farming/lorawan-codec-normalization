// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718DA2 (Wireless 2-Gang Vibration
// Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da2_r718db2_r718f2.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x2F == 47 == R718DA2) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a status
// (measurement) frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`). The R718DA2 has two
// external rolling-ball vibration sensors; bytes[4] (upstream `status1`) and
// bytes[5] (upstream `status2`) are the two gangs' vibration states (non-zero ==
// that gang is currently detecting vibration). Config responses (fPort 7) carry
// no measurement and are reported as errors.
//
// Both gangs report the same quantity at two sub-sensor positions of one device,
// so each rides in the reserved `channels` array (see AUTHORING.md
// "Multi-channel devices") rather than in the suffixed `vibration1` /
// `vibration2` extras this codec used to emit: one entry per gang, labelled with
// the vendor's own term plus a zero-based index — `gang0` (Netvox channel 1,
// bytes[4]) and `gang1` (Netvox channel 2, bytes[5]) — each carrying its own
// `action.motion.detected` boolean. The retired `vibration1`/`vibration2` extras
// lose nothing: the state byte is a two-state flag upstream passes through
// verbatim (0 == idle, non-zero == vibrating), so the per-entry boolean is the
// whole reading and no raw per-entry extra is kept.
//
// Label scheme note: this Netvox 2-position fPort-6 family deliberately does
// NOT use one label word throughout — each codec follows the vendor's own term
// for that product. Netvox brands the R718DA2 (and the spring-type R718DB2) a
// "2-Gang" vibration sensor, so its positions are `gang0`/`gang1`; the sibling
// R311CA / R718J2 are branded "2-Input Dry Contact Interface" and use
// `input0`/`input1`, and the R718WB2 leak detector uses `probe0`/`probe1`. The
// difference tracks the datasheets, not an inconsistency.
//
// Aggregate policy — the old top-level `action.motion.detected` was the
// either-gang OR of the two states. It is REMOVED: each entry now carries its
// own `action.motion.detected` (per-position truth), and AUTHORING forbids
// emitting the same leaf both top-level and inside entries — downstream stores
// keep top-level readings under the empty channel label and would double-count
// the metric. A consumer wanting the whole-device alarm ORs the entries. The
// `motion` category (requires `action.motion`) is still satisfied: membership
// resolves through top-level `channels[]` entries as well as the top level.
//
// `action.motion.count` — the number of gangs currently detecting, 0..2 — DOES
// stay top-level, and is the one reading that should. It is a whole-device
// roll-up over the positions, not a per-position value: no single gang has a
// "count", so putting it inside an entry would either duplicate the same number
// in both entries or restate that entry's own `detected` flag. It is also a
// *different leaf* from `detected`, so keeping it top-level does not violate the
// no-duplicate-leaf rule — `detected` appears only inside entries, `count` only
// at the top level. `battery` and the `lowBattery` flag are likewise whole-device
// readings and stay top-level.
//
// Sentinel policy: this frame format defines NO disconnected-gang sentinel. The
// shared upstream decoder passes both state bytes straight through
// (`status1` = bytes[4], `status2` = bytes[5]) with no reserved "not connected"
// value, and the report layout reserves none either — every value is either zero
// (idle) or non-zero (vibrating) — so no value is treated as a sentinel and
// neither entry is ever suppressed on its reading. Nor can a short frame
// fabricate an idle gang from `undefined`: the length guard below requires all 6
// header+state bytes, so both state bytes are always present when a frame
// decodes and both entries are emitted unconditionally.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4-5: per-gang vibration state for the two rolling-ball sensors.
  // Non-zero == that gang is currently detecting vibration.
  var gang0 = bytes[4] !== 0;
  var gang1 = bytes[5] !== 0;

  var count = 0;
  if (gang0) {
    count = count + 1;
  }
  if (gang1) {
    count = count + 1;
  }

  // Whole-device roll-up: how many gangs are detecting (0..2).
  data.action = { motion: { count: count } };

  // One channels[] entry per gang: byte 4 = Netvox channel 1 (`gang0`),
  // byte 5 = Netvox channel 2 (`gang1`).
  data.channels = [
    { channel: 'gang0', action: { motion: { detected: gang0 } } },
    { channel: 'gang1', action: { motion: { detected: gang1 } } }
  ];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r718da2" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718da2";
  }
  return result;
}
