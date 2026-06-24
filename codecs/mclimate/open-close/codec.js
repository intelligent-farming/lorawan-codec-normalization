// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MClimate Open/Close Sensor (LoRaWAN door/window
// contact sensor with internal event counter, temperature sensor and button).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/open-close.js, attributed in
// NOTICE; sha256 9c38bbf5006a3f6e0219bfac7b9ff8959fd7282015aa4f07aa046ccd8b3bc1ed).
// The TTN decoder is the source of truth for the MClimate fixed 8-byte
// keepalive/data-frame layout; the keepalive arithmetic below is ported
// faithfully from it. We author the normalization ourselves and do NOT copy the
// upstream output shape.
//
// Wire layout of the 8-byte keepalive/data frame (leading byte 0x01):
//   byte[0]      frame type marker (0x01 = keepalive/data frame)
//   byte[1]      battery voltage: raw * 8 + 1600 -> mV
//   byte[2]      bit2 (0x04) = thermistor disconnected flag (0 => connected);
//                bits1:0 = temperature high bits (9:8)
//   byte[3]      temperature low bits (7:0); raw value / 10 -> degrees C
//   byte[4..6]   24-bit big-endian open/close event counter
//   byte[7]      open/close state / event code
//
// Mapping decisions:
//   battery voltage (byte[1])  raw*8+1600 mV /1000  -> battery (V)
//   temperature (bytes[2..3])  10-bit raw /10 °C    -> air.temperature
//   open/close state (byte[7]) bit0: 1=open, 0=closed -> action.contactState
//                                                        ('open' | 'closed')
//   event counter (bytes[4..6])                     -> openCloseCount (extra)
//   raw status/event byte (byte[7])                 -> eventStatus (extra)
//   thermistor-connected flag (byte[2] bit2)        -> thermistorProperlyConnected
//
// The MClimate Open/Close datasheet states the device "sends an uplink for every
// event of opening/closing and keeps an internal counter of the total number of
// events." The 24-bit counter is therefore the cumulative open/close event count
// (camelCase extra `openCloseCount`), and the trailing status byte carries the
// current contact state. Its low bit drives the vocabulary `action.contactState`
// enum (1 => "open", 0 => "closed"); the full raw byte is preserved as the
// `eventStatus` extra so no upstream information is lost.
//
// Battery is reported as a VOLTAGE by this device, so it maps directly to the
// vocabulary `battery` key (volts) — no `batteryPercent` extra is used here.
//
// Non-keepalive frames are configuration-response frames: upstream parses a
// variable-length command section and then decodes the trailing 8-byte
// keepalive tail (bytes.slice(-5) plus the realigned counter/status). This codec
// is a normalized measurement decoder, so it only emits the measurement tail;
// the command section is not modeled. We decode the last 8 bytes as the
// keepalive frame.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contactState(statusByte) {
  // Low bit of the status/event byte indicates the contact state:
  // 1 => open, 0 => closed.
  return (statusByte & 0x01) === 1 ? 'open' : 'closed';
}

// Decode the 8-byte keepalive frame starting at offset `off` within `bytes`.
function decodeKeepalive(bytes, off, data, air, action) {
  // byte[off+1]: battery voltage, raw * 8 + 1600 -> mV, /1000 -> V.
  var batteryVoltage = (bytes[off + 1] * 8 + 1600) / 1000;
  data.battery = round(batteryVoltage, 2);

  // byte[off+2] bit2 (0x04): thermistor disconnected flag (0 => connected).
  var thermistorConnected = (bytes[off + 2] & 0x04) === 0;
  data.thermistorProperlyConnected = thermistorConnected;

  // bytes[off+2] bits1:0 (high bits 9:8) + byte[off+3] (low bits 7:0):
  // 10-bit raw temperature, /10 -> degrees C.
  var temperatureHighBits = bytes[off + 2] & 0x03;
  var temperatureLowBits = bytes[off + 3];
  var temperatureRaw = (temperatureHighBits << 8) | temperatureLowBits;
  air.temperature = round(temperatureRaw / 10, 1);

  // bytes[off+4..off+6]: 24-bit big-endian open/close event counter.
  var counter = (bytes[off + 4] << 16) | (bytes[off + 5] << 8) | bytes[off + 6];
  data.openCloseCount = counter;

  // byte[off+7]: open/close state / event code.
  var status = bytes[off + 7] || 0;
  data.eventStatus = status;
  action.contactState = contactState(status);

  return data;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Keepalive/data frame: leading byte 0x01, 8 bytes total. Anything else is a
  // configuration-response frame whose command section is followed by a trailing
  // 8-byte keepalive frame; we decode only that tail.
  var off;
  if (bytes[0] === 1) {
    off = 0;
  } else {
    off = bytes.length - 8;
  }

  if (off < 0 || bytes.length < off + 8) {
    return { errors: ['payload too short: expected at least an 8-byte keepalive frame'] };
  }

  var data = {};
  var air = {};
  var action = {};
  decodeKeepalive(bytes, off, data, air, action);
  data.air = air;
  data.action = action;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mclimate";
    result.data.model = "open-close";
  }
  return result;
}
