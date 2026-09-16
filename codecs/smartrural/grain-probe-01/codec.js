// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for smartrural/grain-probe-01 (Grain Probe): a
// two-channel grain/silo temperature probe. It is a standalone temperature
// device (its sole sensor is temperature).
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/smartrural/grain-probe.js, referenced
// via grain-probe-codec.yaml, attributed in NOTICE). Normalization authored
// here; upstream output (with its `debug`/`Systimestamp` nesting) is NOT copied.
//
// Wire format (all telemetry on fPort 2):
//   bytes[0..1]  battery: ((hi<<8|lo) & 0x3FFF) / 1000  -> volts (already V)
//   bytes[2]     high nibble bit6 = poll flag; low nibble = Ext (sensor mode):
//                  0x01 -> two temperature channels, hundredths of a degree
//                          (signed16(bytes[3],bytes[4]) / 100  -> °C)
//                  0x02 -> two temperature channels, tenths of a degree (/10)
//                  0x03 -> raw channel resistance (Ω), NOT a temperature
//   bytes[3..6]  two signed-16 big-endian channel values
//   bytes[7..10] Systimestamp: uint32 unix epoch seconds
//
// Normalization: the two grain/silo channels are the same quantity at two
// sub-sensor positions, so each rides in the reserved `channels` array (see
// AUTHORING.md "Multi-channel devices") instead of the old `temperature` +
// `temperature2` pair and the `temperatures` array extra (retired — the bare
// array duplicated the two channel values and was opaque to downstream
// flatteners; that information now lives in the entries). Labels are the
// vendor's own term plus a zero-based index: `channel0` = upstream
// Temp_Channel1 (bytes[3..4]), `channel1` = upstream Temp_Channel2
// (bytes[5..6]). Each entry carries the `temperature` vocabulary key in °C with
// the same per-mode scaling and rounding as before (Ext 0x01 -> ÷100, 2
// decimals; Ext 0x02 -> ÷10, 1 decimal).
//
// Whole-device readings stay top-level and are never duplicated in an entry:
// `battery` (already volts, ÷1000 upstream), the `sensorMode` extra and the
// `deviceTime` extra. Resistance mode (Ext 0x03) reports channel resistance in Ω
// rather than a temperature, so it is still surfaced as an error (no confident
// temperature).
//
// Sentinel policy: this frame format defines NO disconnected-channel sentinel.
// The upstream decoder reads both channel words unconditionally as plain
// two's-complement values and reserves no "no probe" code (unlike sibling
// Dragino-style frames, which use 0x8001 or 0xFFFF), and the mode nibble is
// device-wide rather than per channel. So no value is treated as a sentinel and
// neither entry is ever suppressed on its reading — a disconnected channel is
// indistinguishable from a genuine reading here, and none is invented.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  if (v & 0x8000) {
    v -= 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort (expected 2)'] };
  }
  var bytes = input.bytes;
  if (!bytes || bytes.length < 11) {
    return { errors: ['payload too short (expected 11 bytes)'] };
  }

  var pollStatus = (bytes[2] & 0x40) >> 6;
  if (pollStatus !== 0) {
    return { errors: ['poll-request acknowledgement frame carries no measurement'] };
  }

  var ext = bytes[2] & 0x0f;
  var battery = round((((bytes[0] << 8) | bytes[1]) & 0x3fff) / 1000, 3);
  var scale;
  if (ext === 0x01) {
    scale = 100;
  } else if (ext === 0x02) {
    scale = 10;
  } else {
    return { errors: ['sensor mode 0x' + ext.toString(16) + ' reports no temperature'] };
  }

  var decimals = ext === 0x01 ? 2 : 1;
  var t1 = round(signed16(bytes[3], bytes[4]) / scale, decimals);
  var t2 = round(signed16(bytes[5], bytes[6]) / scale, decimals);

  var data = {};
  data.channels = [
    { channel: 'channel0', temperature: t1 },
    { channel: 'channel1', temperature: t2 }
  ];
  data.battery = battery;
  data.sensorMode = ext;
  data.deviceTime = ((bytes[7] << 24) | (bytes[8] << 16) | (bytes[9] << 8) | bytes[10]) >>> 0;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "smartrural", model: "grain-probe-01" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "smartrural";
    result.data.model = "grain-probe-01";
  }
  return result;
}
