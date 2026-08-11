// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/pulse-4
// (Adeunis "Pulse 4 / Pulse 4 ATEX - Metering Interface": 2-channel pulse meter).
//
// Derivation: wire format understood from the upstream Apache-2.0 shared library
// (TheThingsNetwork/lorawan-devices vendor/adeunis/pulse_lib.js, resolved from
// pulse-4.yaml -> pulse-codec -> uplinkDecoder.fileName, attributed in NOTICE).
// Normalization authored here; the upstream `decode()` bag is NOT copied.
//
// Frame model (byte[0] = frame code, byte[1] = status byte):
//   0x46 Pulse 4 data       -> both channels' cumulative counters
//   0x5a Pulse 4 data ch A  -> channel A datalog (newest + deltas)
//   0x5b Pulse 4 data ch B  -> channel B datalog (newest + deltas)
//   Config/keep-alive/alarm frames (0x10-0x12, 0x20, 0x30, 0x33, 0x47) rejected.
// Status byte[1]: bit0x01 configurationDone, bit0x02 lowBattery,
//   bit0x04 timestamp-present, bits 0xe0>>5 frame counter.
// A trailing 4-byte device timestamp (seconds since 2013-01-01) is appended when
// the timestamp bit is set; it is emitted as top-level `time` (RFC3339).
// The two metering inputs are sub-sensor positions, so each becomes an entry in
// the reserved `channels` array (see AUTHORING.md "Multi-channel devices"),
// labelled with the vendor's own channel letter: `channelA` / `channelB`. Each
// entry carries the vocabulary pulse.total (cumulative counter); a datalog
// frame's prior-sample counters ride in the same entry as the counterHistory
// extra (no trustworthy per-sample time exists, so no `history` array). Status
// flags stay top-level (whole-device). Battery is reported only as a
// low-battery flag, not a value.

var ADEUNIS_EPOCH = 1356998400; // 2013-01-01T00:00:00Z, in seconds

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

function statusExtras(data, status) {
  data.configurationDone = Boolean(status & 0x01);
  data.lowBattery = Boolean(status & 0x02);
  data.frameCounter = (status & 0xe0) >> 5;
}

function decodeDatalog(bytes, channelLabel) {
  var status = bytes[1];
  var hasTimestamp = Boolean(status & 0x04);
  var end = hasTimestamp ? bytes.length - 4 : bytes.length;

  var current = uint32(bytes, 2);
  var history = [];
  var acc = current;
  for (var o = 6; o + 1 < end; o += 2) {
    acc -= uint16(bytes, o);
    history.push(acc);
  }

  var entry = { channel: channelLabel, pulse: { total: current } };
  entry.counterHistory = history;
  var data = { channels: [entry] };
  if (hasTimestamp) {
    data.time = decodeTimestamp(bytes);
  }
  statusExtras(data, status);
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var frameCode = bytes[0];

  if (frameCode === 0x46) {
    if (bytes.length < 10) {
      return { errors: ['expected >=10-byte 0x46 data frame, got ' + bytes.length] };
    }
    var status = bytes[1];
    var data = {
      channels: [
        { channel: 'channelA', pulse: { total: uint32(bytes, 2) } },
        { channel: 'channelB', pulse: { total: uint32(bytes, 6) } }
      ]
    };
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
    result.data.model = "pulse-4";
  }
  return result;
}
