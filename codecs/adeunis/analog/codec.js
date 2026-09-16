// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/analog
// (Adeunis "Analog - Sensor Interface": 2-channel 0-10 V / 4-20 mA interface).
//
// Derivation: wire format understood from the upstream Apache-2.0 shared library
// (TheThingsNetwork/lorawan-devices vendor/adeunis/analog_lib.js, resolved from
// analog.yaml -> analog-codec -> uplinkDecoder.fileName, attributed in NOTICE).
// Normalization authored here; the upstream `decode()` bag is NOT copied.
//
// Frame model (byte[0] = frame code, byte[1] = status byte):
//   0x42 Analog data / 0x30 keep-alive share the measurement layout below.
//   Config/downlink-ack frames (0x10-0x14, 0x20, 0x33) carry no interface
//   reading and are rejected.
// Status byte[1]: bit0x02 lowBattery, bit0x08 alarm ch A, bit0x10 alarm ch B,
//   bits 0xe0>>5 frame counter.
// Per channel (channel A at offset 2, channel B at offset 6): the low nibble of
// the first byte is the sensor type (1 = 0-10 V, 2 = 4-20 mA, 0 = deactivated);
// the reading is the trailing 24 bits. Voltage = raw / 1e6 V, current =
// raw / 1e5 mA.
//
// Normalization: the two interface channels are sub-sensor positions of one
// device, so each becomes an entry in the reserved `channels` array (see
// AUTHORING.md "Multi-channel devices") instead of a suffixed extra —
// labelled with the vendor's own channel letters, `channelA` / `channelB`, the
// same labels the sibling pulse-4 / pulse-nb-iot codecs use for this vendor's
// two positions. Each entry carries the vocabulary analog.voltage (V) or
// analog.current (mA) per its own type nibble (the two channels can be
// configured differently), so `channelBVoltage`/`channelBCurrent` extras are
// gone. The status byte's per-channel alarm bit is an alarm *output* rather
// than a measured position, but it is scoped to one position, so it rides
// inside that position's entry as the `alarm` extra — cleaner than a top-level
// `alarmChannelA`/`alarmChannelB` suffixed pair, and it disappears with the
// entry when the channel is deactivated. The frame counter and low-battery flag
// are whole-device readings and stay top-level. Battery is reported only as a
// low-battery flag, not a value, so no `battery` key is emitted.
//
// Deactivated/sentinel policy: a channel whose type nibble is 0 is deactivated —
// its 24 raw bits carry no reading, so no entry (and no alarm flag) is emitted
// for it. When both channels are deactivated there is no measurement at all:
// the `channels` key is omitted entirely and the frame is reported as an error
// ('no active analog channel in frame'), as before this conversion.

var TYPE_VOLTAGE = 1;
var TYPE_CURRENT = 2;

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function uint24At(bytes, o) {
  // 24-bit big-endian value in bytes[o+1..o+3]; bytes[o] low nibble = type.
  return (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
}

// One channels[] entry for the interface channel at offset `o`, or null when
// that channel is deactivated (type nibble 0).
function channelEntry(bytes, o, label, alarm) {
  var type = bytes[o] & 0x0f;
  var raw = uint24At(bytes, o);
  var entry = { channel: label, analog: {} };
  if (type === TYPE_VOLTAGE) {
    entry.analog.voltage = round(raw / 1000000, 3);
  } else if (type === TYPE_CURRENT) {
    entry.analog.current = round(raw / 100000, 3);
  } else {
    return null;
  }
  entry.alarm = alarm;
  return entry;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var frameCode = bytes[0];

  if (frameCode !== 0x42 && frameCode !== 0x30) {
    return { errors: ['unsupported frame code 0x' + frameCode.toString(16) + ' (expected 0x42 data or 0x30 keep-alive)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected >=10-byte analog data frame, got ' + bytes.length] };
  }

  var status = bytes[1];
  var chA = channelEntry(bytes, 2, 'channelA', Boolean(status & 0x08));
  var chB = channelEntry(bytes, 6, 'channelB', Boolean(status & 0x10));

  if (!chA && !chB) {
    return { errors: ['no active analog channel in frame'] };
  }

  var entries = [];
  if (chA) {
    entries.push(chA);
  }
  if (chB) {
    entries.push(chB);
  }

  var data = { channels: entries };
  data.lowBattery = Boolean(status & 0x02);
  data.frameCounter = (status & 0xe0) >> 5;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "adeunis", model: "analog" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "analog";
  }
  return result;
}
