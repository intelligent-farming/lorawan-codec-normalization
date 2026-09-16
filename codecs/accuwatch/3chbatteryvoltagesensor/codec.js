// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for accuwatch/3chbatteryvoltagesensor (Accuwatch
// 3-Channel Battery Voltage Sensor: three independent analog voltage channels).
// Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Accuwatch decoder
// (TheThingsNetwork/lorawan-devices vendor/accuwatch/3chbatteryvoltagesensor.js,
// attributed in NOTICE). Each channel is an IEEE-754 single-precision float in
// little-endian byte order (4 bytes). Upstream returns the three voltages as
// string keys (sensor1Voltage .. sensor3Voltage via toFixed(2)); this module
// authors numeric normalized vocabulary keys. Upstream normalization is never
// copied.
//
// 12-byte frame (little-endian float32 per channel):
//   bytes[0..3]   channel 1 voltage (V) -> channels[] `channel0`
//   bytes[4..7]   channel 2 voltage (V) -> channels[] `channel1`
//   bytes[8..11]  channel 3 voltage (V) -> channels[] `channel2`
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). The three voltage inputs are sub-sensor positions of one device all
// carrying the same quantity, so each rides in the reserved `channels` array
// rather than in the suffixed `voltage2` / `voltage3` extras this codec used to
// emit: one entry per position, each carrying the `analog.voltage` vocabulary
// key in V with identical scaling and rounding (the raw float32 rounded to 2
// decimals, matching upstream's toFixed(2) resolution). Labels are the vendor's
// own term plus a zero-based index — `channel0` (frame channel 1), `channel1`
// (channel 2), `channel2` (channel 3): Accuwatch brands the product "3ch
// Battery Voltage Sensor", i.e. it calls the positions channels, so `channelN`
// is the vendor's term. Upstream's `sensorNVoltage` keys are not used as the
// label stem — "sensor" there names the whole device (one sensor, three
// channels), and `channelN` matches the label scheme of the other
// fixed-channel-bank codecs in this repo (e.g. dragino/ltc2). The labels are
// zero-based while the vendor numbers the channels 1..3, so `channel0` is
// Accuwatch channel 1.
//
// Nothing is emitted both inside an entry and at the top level: this frame
// carries no whole-device reading at all (no battery, no diagnostics), so after
// the conversion `channels` is the codec's entire measurement payload. The
// `analog-interface` category (atLeastOne includes `analog.voltage`) is still
// satisfied, since membership resolves through top-level `channels[]` entries.
//
// Sentinel policy: this frame format defines NO disconnected-channel sentinel.
// Neither the vendor payload nor the upstream decoder reserves a "no probe"
// value — all three words are plain IEEE-754 floats read across the input's
// full range — so no value is treated as a sentinel and no entry is ever
// suppressed on its reading. A non-finite float (NaN / +-Inf) is NOT treated as
// a per-channel sentinel either: it means a corrupt frame, and the whole uplink
// is rejected with the pre-existing frame-level error (unchanged below).
// Likewise no short frame can fabricate a missing position: the length guard
// requires exactly 12 bytes, so all three channel words are present whenever a
// frame decodes, and `channels` (built lazily) is in practice never omitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Decode a little-endian IEEE-754 float32 from bytes[i..i+3].
function f32le(b, i) {
  var bits = ((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0;
  var sign = (bits & 0x80000000) ? -1 : 1;
  var exponent = ((bits >>> 23) & 0xff) - 127;
  var significand = bits & 0x7fffff;

  if (exponent === 128) {
    return significand ? NaN : sign * Infinity;
  }
  if (exponent === -127) {
    if (significand === 0) {
      return sign * 0;
    }
    exponent = -126;
    significand = significand / (1 << 22);
  } else {
    significand = (significand | (1 << 23)) / (1 << 23);
  }
  return sign * significand * Math.pow(2, exponent);
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length !== 12) {
    return { errors: ['expected 12-byte frame, got ' + (b ? b.length : 0)] };
  }

  var v1 = f32le(b, 0);
  var v2 = f32le(b, 4);
  var v3 = f32le(b, 8);

  if (!isFinite(v1) || !isFinite(v2) || !isFinite(v3)) {
    return { errors: ['non-finite voltage in payload'] };
  }

  // One channels[] entry per voltage channel, same scaling/rounding for each.
  var volts = [v1, v2, v3];
  var channels = [];
  var i;
  for (i = 0; i < volts.length; i++) {
    channels.push({ channel: 'channel' + i, analog: { voltage: round(volts[i], 2) } });
  }

  var data = {};
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
    return { data: { make: "accuwatch", model: "3chbatteryvoltagesensor" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "accuwatch";
    result.data.model = "3chbatteryvoltagesensor";
  }
  return result;
}
