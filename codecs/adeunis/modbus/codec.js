// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/modbus
// (Adeunis "Modbus - Modbus Interface": generic Modbus register transmitter).
//
// Derivation: wire format understood from the upstream Apache-2.0 shared library
// (TheThingsNetwork/lorawan-devices vendor/adeunis/modbus_lib.js, resolved from
// modbus.yaml -> modbus-codec -> uplinkDecoder.fileName, attributed in NOTICE).
// Normalization authored here; the upstream `decode()` bag is NOT copied.
//
// This is a generic Modbus master: the physical meaning of each register is
// defined by the user's Modbus configuration and is opaque at the codec level.
// We therefore decode only the 0x44 "Modbus data (int32)" frame and pass the
// first register through as the vocabulary analog.raw (raw ADC/register count),
// with the full decoded register vector as a camelCase extra. Frames whose
// register width/encoding is not int32 (0x5e uint16, 0x60/0x61 float, 0x45
// alarm) or which are config/keep-alive are rejected as not decodable here.
//
// Frame model: byte[0] frame code, byte[1] status byte
//   (bit0x01 configurationDone, bit0x02 lowBattery, bit0x04 hardwareError,
//    bit0x08 configurationInconsistency, bit0x10 modbusReadError,
//    bits 0xe0>>5 frame counter). 0x44 registers: int32 big-endian from offset 2.

function int32(bytes, o) {
  return (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var frameCode = bytes[0];

  if (frameCode !== 0x44) {
    return { errors: ['unsupported frame code 0x' + frameCode.toString(16) + ' (only 0x44 int32 register data is decodable here)'] };
  }
  if (bytes.length < 6 || (bytes.length - 2) % 4 !== 0) {
    return { errors: ['expected 0x44 frame with whole int32 registers, got ' + bytes.length + ' bytes'] };
  }

  var registers = [];
  for (var o = 2; o + 3 < bytes.length; o += 4) {
    registers.push(int32(bytes, o));
  }

  var status = bytes[1];
  var data = {};
  // Primary register -> analog.raw (opaque device/register count); vocabulary
  // has no physical unit for a user-defined Modbus register.
  data.analog = { raw: registers[0] };
  data.registerValues = registers;
  data.configurationDone = Boolean(status & 0x01);
  data.lowBattery = Boolean(status & 0x02);
  data.hardwareError = Boolean(status & 0x04);
  data.configurationInconsistency = Boolean(status & 0x08);
  data.modbusReadError = Boolean(status & 0x10);
  data.frameCounter = (status & 0xe0) >> 5;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "modbus";
  }
  return result;
}
