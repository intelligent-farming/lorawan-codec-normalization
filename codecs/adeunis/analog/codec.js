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
// raw / 1e5 mA. Channel A maps to the vocabulary analog.voltage/current; channel
// B is a camelCase extra. Battery is reported only as a low-battery flag, not a
// value, so no `battery` key is emitted.

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

// Returns { key, value } for the analog vocabulary, or null if deactivated.
function channelReading(bytes, o) {
  var type = bytes[o] & 0x0f;
  var raw = uint24At(bytes, o);
  if (type === TYPE_VOLTAGE) {
    return { key: 'voltage', value: round(raw / 1000000, 3) };
  }
  if (type === TYPE_CURRENT) {
    return { key: 'current', value: round(raw / 100000, 3) };
  }
  return null;
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
  var chA = channelReading(bytes, 2);
  var chB = channelReading(bytes, 6);

  if (!chA && !chB) {
    return { errors: ['no active analog channel in frame'] };
  }

  var data = { analog: {} };
  if (chA) {
    data.analog[chA.key] = chA.value;
  }
  if (chB) {
    // Channel B is the secondary channel -> camelCase extra.
    data['channelB' + (chB.key === 'voltage' ? 'Voltage' : 'Current')] = chB.value;
  }
  data.lowBattery = Boolean(status & 0x02);
  data.alarmChannelA = Boolean(status & 0x08);
  data.alarmChannelB = Boolean(status & 0x10);
  data.frameCounter = (status & 0xe0) >> 5;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "analog";
  }
  return result;
}
