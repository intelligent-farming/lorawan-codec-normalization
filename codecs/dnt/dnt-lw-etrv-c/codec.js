// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the dnt dnt-LW-eTRV-C (controllable LoRaWAN
// radiator thermostat).
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dnt/dnt-lw-etrv-c.js, attributed in
// NOTICE). Normalization authored here; upstream command-stream output is NOT
// copied.
//
// Same command-ID / TLV scheme as dnt-lw-etrv, but the GET_STATUS (0x04) frame
// scales three fields differently on the -C firmware:
//   bit7 battery voltage: byte -> mV = byte*10 + 1500  -> battery (V, /1000)
//   bit6 room temperature: 2 bytes, (hi<<8|lo)*0.1 °C  -> air.temperature (°C)
//   bit5 set-point temperature: byte*0.5 °C            -> hvac.setpoint (°C)
//   bit4 valve position: byte*0.5 %                    -> hvac.valvePosition (%)
//   bit3 controller gains (2+1 bytes) — skipped
//   bit2 device flags: bits7..5 active mode -> hvac.mode (only if a byte remains)
// Only the GET_STATUS command is decoded; other command frames carry no
// measurement and are reported as errors.

var ACTIVE_MODE = ['Manu Temp', 'Manu_Pos', 'Auto', 'Emergency', 'Frost Protection', 'Boost', 'Window Open', 'Holiday'];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeStatusFrame(bytes) {
  var reg = bytes[1];
  var idx = 2;
  var data = {};
  var hvac = {};

  if (reg & 0x80) {
    data.battery = round((bytes[idx] * 10 + 1500) / 1000, 3);
    idx += 1;
  }
  if (reg & 0x40) {
    // -C firmware: room temperature is a 16-bit big-endian value in 0.1 °C.
    data.air = { temperature: round(((bytes[idx] << 8) | bytes[idx + 1]) * 0.1, 1) };
    idx += 2;
  }
  if (reg & 0x20) {
    hvac.setpoint = round(bytes[idx] * 0.5, 1);
    idx += 1;
  }
  if (reg & 0x10) {
    hvac.valvePosition = round(bytes[idx] * 0.5, 1);
    idx += 1;
  }
  if (reg & 0x08) {
    idx += 3;
  }
  if ((reg & 0x04) && idx < bytes.length) {
    hvac.mode = ACTIVE_MODE[(bytes[idx] & 0xE0) >> 5];
    idx += 1;
  }

  if (hvac.setpoint === undefined && hvac.valvePosition === undefined) {
    return { errors: ['status frame carries neither set-point nor valve position'] };
  }

  data.hvac = hvac;
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return { errors: ['expected at least 2 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[0] !== 0x04) {
    return { errors: ['unsupported command 0x' + bytes[0].toString(16) + ' (expected 0x04 GET_STATUS)'] };
  }
  return decodeStatusFrame(bytes);
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dnt";
    result.data.model = "dnt-lw-etrv-c";
  }
  return result;
}
