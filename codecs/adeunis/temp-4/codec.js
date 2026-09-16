// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/temp-4 (Temp 4 / Temp 2S 4 IP68
// temperature probe): a standalone LoRaWAN temperature sensor with one or two
// probe channels (PT100/thermocouple), reporting periodic historized samples.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/adeunis/temp_lib.js, referenced via
// temp-codec.yaml, attributed in NOTICE). Adeunis devices share this
// `temp_lib.js`; the temp-4 profile uses the `temp4` parser set. Normalization
// authored here; upstream output shape (nested `bytes`/`temperatures[]`
// name/unit objects) is NOT copied.
//
// Frame layout (dispatched by frame code = bytes[0]):
//   0x57  periodic data (PRIMARY telemetry). bytes[1] = status byte:
//           bit4 (0x10) -> 2 channels active, else 1 channel
//           bit2 (0x04) -> a 4-byte epoch timestamp trails the samples
//           bit1 (0x02) -> low-battery flag
//         Samples are big-endian signed-16, tenths of a degree (/10 -> °C),
//         interleaved per channel, ordered [t=0, t-1, t-2, ...] (t=0 = current).
//   0x30  keep-alive: a single current sample per channel (same scaling).
//   0x10/0x20/0x2f/0x33/0x36/0x37/0x58  configuration / ack / alarm / version
//         frames -> not periodic telemetry -> reported as an error.
//
// Normalization: the two probe channels are sub-sensor positions of one device,
// so each becomes an entry in the reserved `channels` array (see AUTHORING.md
// "Multi-channel devices") rather than a suffixed extra pair. Label scheme:
// `channel1` / `channel2` — this device's wire format and `temp_lib.js` number
// the probes ("temperature 1"/"temperature 2", status bit
// `configuration2ChannelsActivated`), where the sibling pulse family letters its
// inputs (frame codes 0x5a "data ch A" / 0x5b "data ch B" -> `channelA` /
// `channelB`); each codec uses the vendor's own term for its own positions.
// Each entry carries the vocabulary `temperature` (°C) for its current (t=0)
// sample plus that channel's full sample series as the `temperatureSamples`
// extra, ordered [t=0, t-1, t-2, ...] (element 0 is the entry's `temperature`).
// The frame counter, the low-battery flag and the optional device timestamp
// (`time`, RFC3339) are whole-device readings and stay top-level. The device has
// no battery-voltage telemetry (only a low-battery status bit), so `battery`
// (volts) is not emitted.
//
// Disconnected-position policy: the number of live probes is declared by status
// bit4 — a `channel2` entry is emitted only when that 2-channels bit is set. In
// 1-channel mode the payload carries no channel-2 samples at all, so there is
// nothing to sentinel-check; no entry is emitted for the unused position.
//
// Scope note: the sample series is a datalog ordered [t=0, t-1, t-2, ...], but
// the frame carries no per-sample time (only an optional timestamp for the
// frame, and no sampling period), so the prior samples cannot be given
// trustworthy RFC3339 `time` values. They therefore ride as a plain array extra
// inside the channel entry, not as a reserved `history` array — and channels
// entries are leaf measurements, which may not nest `history` anyway.

var ADEUNIS_EPOCH = 1356998400; // 2013-01-01T00:00:00Z, in seconds

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

function decodeTimestamp(bytes) {
  var o = bytes.length - 4;
  var secs = (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0) + ADEUNIS_EPOCH;
  return new Date(secs * 1000).toISOString();
}

// One channels[] entry: current sample -> temperature, series -> extra.
function channelEntry(label, samples) {
  return { channel: label, temperature: samples[0], temperatureSamples: samples };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['missing or too-short payload'] };
  }
  var frameCode = bytes[0];

  if (frameCode === 0x57 || frameCode === 0x30) {
    var status = bytes[1];
    var nbSensors = (status & 0x10) ? 2 : 1;
    var hasTimestamp = Boolean(status & 0x04);
    var lowBattery = Boolean(status & 0x02);

    // Sample region excludes the trailing 4-byte timestamp when present.
    var sampleEnd = hasTimestamp ? bytes.length - 4 : bytes.length;
    if (sampleEnd < 2 + 2 * nbSensors) {
      return { errors: ['0x' + frameCode.toString(16) + ' frame too short for ' + nbSensors + ' channel(s)'] };
    }

    var ch1 = [];
    var ch2 = [];
    for (var offset = 2; offset + 2 * nbSensors <= sampleEnd; offset += 2 * nbSensors) {
      ch1.push(round(signed16(bytes[offset], bytes[offset + 1]) / 10, 1));
      if (nbSensors === 2) {
        ch2.push(round(signed16(bytes[offset + 2], bytes[offset + 3]) / 10, 1));
      }
    }

    var entries = [channelEntry('channel1', ch1)];
    if (nbSensors === 2) {
      entries.push(channelEntry('channel2', ch2));
    }

    var data = { channels: entries };
    if (hasTimestamp) {
      data.time = decodeTimestamp(bytes);
    }
    data.frameCounter = (status & 0xe0) >> 5;
    data.lowBattery = lowBattery;
    return { data: data };
  }

  return { errors: ['frame 0x' + frameCode.toString(16) + ' is not periodic temperature telemetry'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "adeunis", model: "temp-4" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "temp-4";
  }
  return result;
}
