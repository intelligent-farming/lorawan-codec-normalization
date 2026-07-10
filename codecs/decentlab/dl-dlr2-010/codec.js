// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-DLR2-010 (Dual Pulse Counter Dry
// Contact Sensor Transmitter for LoRaWAN): two independent dry-contact pulse
// counters. The metered quantity is defined by the attached pulse sources, so
// this device maps to the `analog-interface` category (`pulse.count` /
// `pulse.total`).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported faithfully from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-dlr2-010.js,
// attributed in NOTICE). The per-sensor conversion formulas below are ported
// verbatim from the upstream SENSORS table; the results are then mapped onto
// the shared normalized vocabulary. Upstream normalizeUplink is NOT copied.
//
// Mapping (flag bit order, LSB first):
//   bit0 channel-0 pulse block (4 words): x[0]=count -> `pulse.count`;
//     x[1]=interval (s) -> extra pulseInterval; x[2]+x[3]*65536 = cumulative ->
//     `pulse.total`.
//   bit1 channel-1 pulse block (4 words): mapped to the extras pulseCount2 /
//     pulseInterval2 / pulseTotal2 (the vocabulary models a single pulse input).
//   bit2 battery (1 word): x[0] / 1000 -> V -> `battery`.
// Protocol header fields are emitted as the extras protocolVersion / deviceId.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short: need at least 5 header bytes'] };
  }

  var version = bytes[0];
  if (version !== 2) {
    return { errors: ["protocol version " + version + " doesn't match v2"] };
  }

  var deviceId = u16be(bytes[1], bytes[2]);
  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first):
  //   bit0 ch0 pulse (4 words), bit1 ch1 pulse (4 words), bit2 battery (1 word).
  var lengths = [4, 4, 1];

  var pos = 5;
  var words = [];
  var i;
  var f = flags;
  for (i = 0; i < lengths.length; i++) {
    if (f & 1) {
      var block = [];
      var j;
      for (j = 0; j < lengths[i]; j++) {
        if (pos + 1 >= bytes.length) {
          return { errors: ['payload too short: truncated sensor block'] };
        }
        block.push(u16be(bytes[pos], bytes[pos + 1]));
        pos += 2;
      }
      words[i] = block;
    }
    f >>= 1;
  }

  var data = {};
  data.protocolVersion = version;
  data.deviceId = deviceId;

  var hasPulse = false;

  // bit0: channel-0 pulse counter.
  if (words[0]) {
    data.pulse = {
      count: words[0][0],
      total: words[0][2] + words[0][3] * 65536
    };
    data.pulseInterval = words[0][1];
    hasPulse = true;
  }

  // bit1: channel-1 pulse counter (extras).
  if (words[1]) {
    data.pulseCount2 = words[1][0];
    data.pulseInterval2 = words[1][1];
    data.pulseTotal2 = words[1][2] + words[1][3] * 65536;
    hasPulse = true;
  }

  // bit2: battery voltage (already volts).
  if (words[2]) {
    data.battery = round(words[2][0] / 1000, 3);
  }

  if (!hasPulse) {
    return { errors: ['no pulse field in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-dlr2-010";
  }
  return result;
}
