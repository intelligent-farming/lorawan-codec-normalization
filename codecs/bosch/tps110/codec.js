// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Bosch TPS110 Parking Lot Sensor (magnetometer/
// radar parking-space occupancy with onboard temperature).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (per-fPort message types) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices vendor/bosch/
// tpl110-0292.js, attributed in NOTICE). Do NOT copy upstream normalizeUplink.
//
// Messages: fPort 1 parking status, fPort 2 heartbeat (status + temperature),
// fPort 3 start-up (status + diagnostics), fPort 4 device information, fPort 5
// device usage, fPort 6 debug. The occupied/vacant state (low bit of the status
// byte) maps to action.occupancy.occupied (true = occupied). The heartbeat
// temperature is a signed 8-bit degrees-Celsius value -> air.temperature. The
// device does not report battery voltage or a state-hold duration, so `battery`
// and action.occupancy.duration are not emitted. Diagnostics with no vocabulary
// key (message type, debug codes, firmware version, reset cause, raw payloads)
// are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s8(b) {
  var v = b & 0xff;
  return v > 0x7f ? v - 0x100 : v;
}

var RESET_CAUSES = [null, 'watchdog', 'power on', 'system request', 'other'];

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var action = {};
  var occupancy = {};

  switch (input.fPort) {
    case 1: // Parking status
      data.messageType = 'parking status';
      occupancy.occupied = (bytes[0] & 0x1) === 0x1;
      action.occupancy = occupancy;
      data.action = action;
      return { data: data };

    case 2: // Heartbeat
      data.messageType = 'heartbeat';
      occupancy.occupied = (bytes[0] & 0x1) === 0x1;
      action.occupancy = occupancy;
      data.action = action;
      if (bytes.length >= 2) {
        data.air = { temperature: round(s8(bytes[1]), 1) };
      }
      return { data: data };

    case 3: // Start-up
      if (bytes.length < 17) {
        return { errors: ['startup payload too short'] };
      }
      data.messageType = 'startup';
      var debugCodes = [];
      for (var i = 0; i <= 8; i += 4) {
        var code = ((bytes[i + 1] & 0xf) << 8) | bytes[i];
        if (code) {
          debugCodes.push(code);
        }
      }
      data.debugCodes = debugCodes;
      data.firmwareVersion = bytes[12] + '.' + bytes[13] + '.' + bytes[14];
      data.resetCause = RESET_CAUSES[bytes[15]];
      occupancy.occupied = (bytes[16] & 0x1) === 0x1;
      action.occupancy = occupancy;
      data.action = action;
      return { data: data };

    case 4: // Device information
      data.messageType = 'device information';
      data.rawBytes = bytes.slice(0);
      return { data: data };

    case 5: // Device usage
      data.messageType = 'device usage';
      data.rawBytes = bytes.slice(0);
      return { data: data };

    case 6: // Debug
      if (bytes.length < 10) {
        return { errors: ['debug payload too short'] };
      }
      data.messageType = 'debug';
      data.timestamp =
        ((bytes[3] << 24) |
          (bytes[2] << 16) |
          (bytes[1] << 8) |
          bytes[0]) >>> 0;
      data.debugCode = ((bytes[5] & 0xf) << 8) | bytes[4];
      data.sequenceNumber = (bytes[9] << 8) | bytes[8];
      return { data: data };

    default:
      return { errors: ['unsupported fPort: ' + input.fPort] };
  }
}
