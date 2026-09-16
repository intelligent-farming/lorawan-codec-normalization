// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718WA2 (Wireless 2-Gang Water Leak
// Detector, 2-probe), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r311w.js, the shared
// family decoder that also handles deviceType 0x46 = 70 = R718WA2; attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports. bytes[0] is the protocol version,
// bytes[1] the device type (0x46 = 70 = R718WA2), bytes[2] the report-type
// discriminator. Report type 0x00 is the device-info / startup frame (software
// version, hardware version, datecode) and carries no measurement. For a status
// report: bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`). This 2-probe variant has no
// temperature/humidity sensor. Config responses (fPort 7) carry no measurement
// and are reported as errors.
//
// bytes[4] and bytes[5] are the two leak-probe states (non-zero = leak
// detected): bytes[4] is Netvox probe 1, bytes[5] is Netvox probe 2. They are
// sub-sensor positions of one device reporting the same quantity, so each
// probe's state rides in the reserved `channels` array (see AUTHORING.md
// "Multi-channel devices") rather than in suffixed `water.leak1` /
// `water.leak2` extras (suffixed keys nested inside the `water` vocabulary
// group — retired here): one entry per probe carrying the `water.leak`
// vocabulary boolean, labelled with the vendor's own term plus a zero-based
// index — `probe0` (Netvox probe 1, bytes[4]) and `probe1` (Netvox probe 2,
// bytes[5]).
//
// Label scheme — why `probe0` and not `gang0`, even though this model is
// branded "2-Gang": Netvox's own term for a leak sensor position across this
// family is the probe (the sibling R311W and R718WB2 are sold as probe /
// rope-probe detectors), and one scheme is used for all three so the family is
// comparable. `gang0` stays with the 2-gang *temperature* family (R718B2 et
// al.), whose datasheet name really is "2-Gang Temperature Sensor".
//
// Aggregate policy — the old top-level `water.leak` was the any-probe OR of the
// two probes. It is REMOVED: each entry now carries its own `water.leak`
// (per-position truth), and AUTHORING forbids emitting the same leaf both
// top-level and inside entries — downstream stores keep top-level readings
// under the empty channel label and would double-count the leak metric. A
// consumer wanting the whole-device alarm ORs the entries. The `water-leak`
// category (requires `water.leak`) is still satisfied: membership resolves
// through top-level `channels[]` entries. `battery` and the `lowBattery` flag
// are whole-device readings and stay top-level; no leaf is emitted in both
// places.
//
// Sentinel policy: this frame format defines NO disconnected-probe sentinel.
// The shared upstream decoder maps each probe byte with a plain two-way test
// (`bytes[4] == 0x00 ? 'NoLeak' : 'Leak'`) and reserves no third "probe not
// connected" value, so no value is treated as a sentinel and neither probe
// entry is ever suppressed on its reading. Nor can a short frame fabricate a
// dry probe from `undefined`: the length guard below requires all 6
// header+measurement bytes, so both probe bytes are always present when a
// frame decodes.

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

  // One channels[] entry per leak probe: bytes[4] = Netvox probe 1 (`probe0`),
  // bytes[5] = Netvox probe 2 (`probe1`); non-zero = leak detected.
  data.channels = [
    { channel: 'probe0', water: { leak: bytes[4] ? true : false } },
    { channel: 'probe1', water: { leak: bytes[5] ? true : false } }
  ];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r718wa2" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718wa2";
  }
  return result;
}
