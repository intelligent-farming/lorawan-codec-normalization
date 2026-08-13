// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for makerfabs/4-channel-adc (Makerfabs 4-Channel ADC
// 12-bit LoRaWAN node: four single-ended analog voltage inputs, plus an optional
// differential reading). Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Makerfabs decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/4-channel-adc.js, attributed
// in NOTICE). Upstream emits opaque fieldN keys; this module authors normalized
// vocabulary keys. Upstream normalization is never copied.
//
// 17-byte frame (big-endian):
//   bytes[0..1]   frame counter                       -> frameCounter (extra)
//   byte[2]       battery, decivolts (/10)            -> battery (V)
//   bytes[3..4]   ADC1, mV (/1000)                    -> channels[] `adc0`
//   bytes[5..6]   ADC2, mV (/1000)                    -> channels[] `adc1`
//   bytes[7..8]   ADC3, mV (/1000)                    -> channels[] `adc2`
//   bytes[9..10]  ADC4, mV (/1000)                    -> channels[] `adc3`
//   bytes[11..12] differential input, mV (/1000)      -> differentialVoltage (V extra)
//   bytes[13..16] measurement interval, ms (/1000)    -> reportingInterval (s extra)
//
// The ADC value carries a real unit (volts), so each channel maps to
// analog.voltage rather than analog.raw.
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). The four single-ended ADC inputs are sub-sensor positions of one
// device all carrying the same quantity, so each rides in the reserved
// `channels` array rather than in the suffixed `voltage2` / `voltage3` /
// `voltage4` extras this codec used to emit: one entry per input, each carrying
// the `analog.voltage` vocabulary key in V with identical scaling and rounding
// (mV / 1000, 3 decimals — the ADC's own 1 mV step). Labels are the vendor's own
// term plus a zero-based index — `adc0` (ADC1, bytes[3..4]), `adc1` (ADC2),
// `adc2` (ADC3), `adc3` (ADC4): both the upstream decoder and the vendor's
// downlink documentation call the positions ADC1..ADC4, so `adcN` is the
// vendor's term (the labels are zero-based while the vendor numbers from 1, so
// `adc0` is ADC1). Whole-device readings stay TOP-LEVEL and are never
// duplicated inside an entry: `battery`, the `frameCounter` frame counter, the
// `reportingInterval` sampling period, and `differentialVoltage` (below). The
// `analog-interface` category (atLeastOne includes `analog.voltage`) is still
// satisfied, since membership resolves through top-level `channels[]` entries.
//
// `differentialVoltage` stays TOP-LEVEL — it is a derived whole-device reading
// across a FIXED PAIR of channels, not a fifth position. The vendor's downlink
// documentation (reference/upstream-codec.js, fPort 6/7 notes) makes the pairing
// explicit: fPort 7 "set[s] the third and fourth channels as differential
// inputs", and the fPort 6 channel-enable truth table lists "Differentialbits"
// as a bit alongside ADC1..ADC4 that may only be enabled when fPort 7 is set to
// 1. The value in bytes[11..12] is therefore the differential measurement across
// ADC3 and ADC4 — entries `adc2` and `adc3` — and belongs to the pair rather
// than to any single position, so scoping it into one entry would misattribute
// it and duplicating it into both would double-count it.
//
// Sentinel policy: this frame format defines NO disconnected-channel sentinel.
// Neither the vendor payload nor the upstream decoder reserves a "no probe"
// value — every ADC word is a plain unsigned big-endian millivolt reading across
// the input's full range — so no value is treated as a sentinel and no entry is
// ever suppressed on its reading. In particular a channel switched off by the
// fPort 6 downlink still occupies its two bytes and reads 0 mV, which is
// indistinguishable from a genuine 0 V measurement: the frame carries no enable
// mask, so a disabled channel cannot be detected and is reported as 0 V rather
// than dropped. Nor can a short frame fabricate a missing position — the length
// guard requires exactly 17 bytes, so all four ADC words are present whenever a
// frame decodes, and `channels` (built lazily) is in practice never omitted.

// UNRESOLVED — the scale of `reportingInterval`. The vendor's own downlink
// Encoder in reference/upstream-codec.js writes this SAME 4-byte big-endian field
// as SECONDS (minutes * 60, floored at 300), while its uplink decoder divides the
// field by 1000, i.e. reads it back as milliseconds. Both readings cannot be
// right, and nothing in the vendor material settles it. This codec keeps
// upstream's /1000 rather than silently picking the other reading, and the
// synthetic vectors carry wire values scaled to match — so if real hardware turns
// out to report seconds, the divisor here and those vector inputs move together
// (a device set to the 3600 s the vectors describe would then decode as 3.6).
// Confirm against a capture from a real unit before trusting this value.
// It is a camelCase extra, so no category membership or vocabulary key rides on it.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(b, i) {
  return ((b[i] << 8) | b[i + 1]) & 0xffff;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length !== 17) {
    return { errors: ['expected 17-byte frame, got ' + (b ? b.length : 0)] };
  }

  var data = {
    frameCounter: u16(b, 0),
    battery: round(b[2] / 10, 1),
    differentialVoltage: round(u16(b, 11) / 1000, 3),
    reportingInterval: round((((b[13] << 24) | (b[14] << 16) | (b[15] << 8) | b[16]) >>> 0) / 1000, 3)
  };

  // One channels[] entry per ADC input (ADC1..ADC4 -> adc0..adc3), same
  // mV -> V scaling and rounding for each.
  var channels = [];
  var i;
  for (i = 0; i < 4; i++) {
    channels.push({
      channel: 'adc' + i,
      analog: { voltage: round(u16(b, 3 + i * 2) / 1000, 3) }
    });
  }
  if (channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "4-channel-adc";
  }
  return result;
}
