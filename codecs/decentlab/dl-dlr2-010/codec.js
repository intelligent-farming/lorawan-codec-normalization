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
// Sensor blocks (flag bit order, LSB first), from the upstream SENSORS table:
//   bit0 channel-0 pulse block (4 words), bit1 channel-1 pulse block (4 words) —
//     each x[0]=pulse count, x[1]=pulse interval (s),
//     x[2]+x[3]*65536 = cumulative pulse count.
//   bit2 battery (1 word): x[0] / 1000 -> V.
//
// Mapping: the two dry-contact terminals are sub-sensor positions of one device
// counting the same physical quantity, so each present channel becomes one entry
// in the reserved `channels` array (see AUTHORING.md "Multi-channel devices")
// instead of the suffixed extras (`pulseCount2` / `pulseInterval2` /
// `pulseTotal2`) this codec used to emit. Entries are labelled with the vendor's
// own channel term plus the wire index — `channel0` / `channel1`, after
// upstream's `ch0_*` / `ch1_*` field names — and each carries that channel's
// `pulse.count` (pulses in the reporting window) and `pulse.total` (cumulative
// counter) plus the per-channel `pulseInterval` extra (the reporting window in
// seconds, unsuffixed inside its entry). `pulse.*` therefore appears ONLY inside
// entries: neither terminal is a whole-device reading, and the two counters must
// never be merged or summed. Whole-device battery voltage (already volts) stays
// top-level as `battery`, as do the protocol-header framing diagnostics, emitted
// as the extras protocolVersion / deviceId.
//
// Presence / sentinel policy: the Decentlab sensor-flags bitmap is the presence
// indicator — a channel whose flag bit is clear contributes no words to the
// payload and gets no entry, and entry labels follow the wire index rather than
// the array position, so a channel-1-only frame (flags 0x0006) still reports
// `channel1`. There is no in-band sentinel value: a count of 0 is a real reading
// (upstream example 1 reports ch1 pulse count 0 on a connected input). The
// `channels` key is omitted when neither pulse block is present, and such a frame
// — e.g. the battery-only frame of upstream example 2 (flags 0x0004) — is
// rejected with the error `no pulse field in payload`, exactly as before this
// codec grew `channels[]`.

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

  // bit0 / bit1: the two dry-contact pulse channels — one channels entry per
  // channel whose flag bit is set, labelled by the wire channel index (never
  // renumbered to close a gap).
  var channels = [];
  var c;
  for (c = 0; c < 2; c++) {
    if (words[c]) {
      var w = words[c];
      channels.push({
        channel: 'channel' + c,
        pulse: {
          count: w[0],
          total: w[2] + w[3] * 65536
        },
        pulseInterval: w[1]
      });
    }
  }

  if (channels.length === 0) {
    return { errors: ['no pulse field in payload'] };
  }
  data.channels = channels;

  // bit2: battery voltage (already volts), a whole-device reading.
  if (words[2]) {
    data.battery = round(words[2][0] / 1000, 3);
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
