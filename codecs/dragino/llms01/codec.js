// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LLMS01 (Leaf Moisture & Leaf
// Temperature Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/llms01-codec.yaml,
// attributed in NOTICE); the normalization below is authored for this module,
// not copied.
//
// Wire format (fPort 2, 11 bytes):
//   bytes 0-1  battery voltage, low 14 bits, mV -> V
//   bytes 2-3  external DS18B20 probe temperature, signed 16-bit, 0.1 C
//   bytes 4-5  leaf moisture / wetness, 0.1 %
//   bytes 6-7  leaf temperature, signed 16-bit, 0.1 C
//   byte  8    interrupt flag
//   byte  10   message type (byte 9 reserved)
//
// Note: the upstream decode uses `(value - 0xffff)` for negative leaf/probe
// temperatures, which is off by one count (0.1 C). This codec uses the correct
// two's-complement `(value - 0x10000)`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var data = {};
  var leaf = {};

  // Bytes 0-1: battery voltage, low 14 bits, millivolts -> volts.
  var battRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
  data.battery = round(battRaw / 1000, 3);

  // Bytes 2-3: external DS18B20 probe temperature, signed 16-bit, 0.1 C.
  // Not a leaf/canopy measurement -> camelCase extra.
  var pRaw = (bytes[2] << 8) | bytes[3];
  if (pRaw & 0x8000) {
    pRaw = pRaw - 0x10000;
  }
  data.probeTemperature = round(pRaw / 10, 1);

  // Bytes 4-5: leaf moisture / surface wetness, 0.1 % -> %.
  var wRaw = (bytes[4] << 8) | bytes[5];
  leaf.wetness = round(wRaw / 10, 1);

  // Bytes 6-7: leaf temperature, signed 16-bit, 0.1 C.
  var ltRaw = (bytes[6] << 8) | bytes[7];
  if (ltRaw & 0x8000) {
    ltRaw = ltRaw - 0x10000;
  }
  leaf.temperature = round(ltRaw / 10, 1);

  data.leaf = leaf;

  // Byte 8: interrupt flag. Byte 10: message/frame type selector.
  data.interruptFlag = bytes[8];
  data.messageType = bytes[10];

  return { data: data };
}
