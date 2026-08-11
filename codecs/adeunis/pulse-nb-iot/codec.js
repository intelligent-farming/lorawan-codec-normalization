// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/pulse-nb-iot
// (Adeunis "Pulse 4 NB-IoT - Metering Interface": 2-channel pulse meter, NB-IoT).
//
// Derivation: wire format understood from the upstream Apache-2.0 shared library
// (TheThingsNetwork/lorawan-devices vendor/adeunis/pulse_nbiot_lib.js, resolved
// from pulse-nb-iot.yaml -> pulse-nb-iot-codec -> uplinkDecoder.fileName,
// attributed in NOTICE). Normalization authored here; the upstream `decode()`
// bag is NOT copied.
//
// The NB-IoT variant prefixes the LoRa Pulse 4 frame with a 13-byte header:
//   bytes[0..7]   IMEI (two big-endian uint32 words, hex-concatenated)
//   byte[8]       signal quality
//   bytes[9..12]  global frame counter (big-endian uint32)
// The application frame then begins at byte 13 (hOffset), identical to the LoRa
// Pulse 4 layout: byte[13] frame code, byte[14] status byte.
//   0x46 data -> both channels' cumulative counters
//   0x5a / 0x5b datalog -> channel A / B (newest + prior-sample deltas)
// Status byte: bit0x01 configurationDone, bit0x02 lowBattery, bit0x04 timestamp,
//   bits 0xe0>>5 frame counter. A trailing 4-byte device timestamp (seconds
//   since 2013-01-01) is appended when the timestamp bit is set -> top-level
//   `time` (RFC3339). The two metering inputs are sub-sensor positions, so each
//   becomes an entry in the reserved `channels` array (see AUTHORING.md
//   "Multi-channel devices"), labelled `channelA` / `channelB`; each entry
//   carries the vocabulary pulse.total, and a datalog frame's prior-sample
//   counters ride in the same entry as the counterHistory extra (no trustworthy
//   per-sample time exists, so no `history` array). Status flags and the NB-IoT
//   header fields stay top-level (whole-device). Battery is reported only as a
//   low-battery flag, not a value.

var ADEUNIS_EPOCH = 1356998400; // 2013-01-01T00:00:00Z, in seconds
var H = 13; // NB-IoT header offset

function uint32(bytes, o) {
  return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
}

function uint16(bytes, o) {
  return (bytes[o] << 8) | bytes[o + 1];
}

function decodeTimestamp(bytes) {
  var secs = uint32(bytes, bytes.length - 4) + ADEUNIS_EPOCH;
  return new Date(secs * 1000).toISOString();
}

function nbIotHeader(data, bytes) {
  data.imei = uint32(bytes, 0).toString(16) + uint32(bytes, 4).toString(16);
  data.signalQuality = bytes[8];
  data.globalFrameCounter = uint32(bytes, 9);
}

function statusExtras(data, status) {
  data.configurationDone = Boolean(status & 0x01);
  data.lowBattery = Boolean(status & 0x02);
  data.frameCounter = (status & 0xe0) >> 5;
}

function decodeDatalog(bytes, channelLabel) {
  var status = bytes[H + 1];
  var hasTimestamp = Boolean(status & 0x04);
  var end = hasTimestamp ? bytes.length - 4 : bytes.length;

  var current = uint32(bytes, H + 2);
  var history = [];
  var acc = current;
  for (var o = H + 6; o + 1 < end; o += 2) {
    acc -= uint16(bytes, o);
    history.push(acc);
  }

  var entry = { channel: channelLabel, pulse: { total: current } };
  entry.counterHistory = history;
  var data = { channels: [entry] };
  nbIotHeader(data, bytes);
  if (hasTimestamp) {
    data.time = decodeTimestamp(bytes);
  }
  statusExtras(data, status);
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (bytes.length < H + 10) {
    return { errors: ['expected >=' + (H + 10) + '-byte NB-IoT pulse frame, got ' + bytes.length] };
  }

  var frameCode = bytes[H];
  if (frameCode === 0x46) {
    var status = bytes[H + 1];
    var data = {
      channels: [
        { channel: 'channelA', pulse: { total: uint32(bytes, H + 2) } },
        { channel: 'channelB', pulse: { total: uint32(bytes, H + 6) } }
      ]
    };
    nbIotHeader(data, bytes);
    if (status & 0x04) {
      data.time = decodeTimestamp(bytes);
    }
    statusExtras(data, status);
    return { data: data };
  }
  if (frameCode === 0x5a) {
    return decodeDatalog(bytes, 'channelA');
  }
  if (frameCode === 0x5b) {
    return decodeDatalog(bytes, 'channelB');
  }
  return { errors: ['unsupported frame code 0x' + frameCode.toString(16) + ' (expected 0x46 data or 0x5a/0x5b datalog)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "pulse-nb-iot";
  }
  return result;
}
