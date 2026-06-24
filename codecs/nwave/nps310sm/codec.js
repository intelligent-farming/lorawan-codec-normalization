// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nwave NPS-3.10-SM Smart Parking Sensor
// (magnetometer/temperature/proximity parking-occupancy node).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (per-fPort message types, occupancy carried in bit 0 of the first
// byte) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/nwave/nps310sm.js, attributed in
// NOTICE). Do NOT copy upstream normalizeUplink.
//
// Messages are distinguished by fPort: 1 = parking status, 2 = heartbeat,
// 3 = startup, 6 = debug. The parking/heartbeat/startup messages carry the
// space-occupied state in bit 0 of byte 0, normalized to
// action.occupancy.occupied (boolean, true = occupied). The startup message
// additionally reports firmware version and reset cause (camelCase extras).
// The debug message carries only raw diagnostic bytes (no occupancy field).
// The Nwave wire format parsed here contains no temperature or battery field,
// so air.temperature and battery are not emitted.

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};

  if (input.fPort === 1 || input.fPort === 2) {
    // Parking status (1) / heartbeat (2): occupancy in bit 0 of byte 0.
    data.messageType = input.fPort === 1 ? 'parkingStatus' : 'heartbeat';
    data.action = { occupancy: { occupied: (bytes[0] & 0x1) === 0x1 } };
    return { data: data };
  }

  if (input.fPort === 3) {
    // Startup: firmware version (3 bytes), reset cause (1 byte), occupancy.
    if (bytes.length < 5) {
      return { errors: ['startup payload too short'] };
    }
    var resetCauses = [
      undefined,
      'watchdog',
      'power_on',
      'user_request',
      'brownout',
      'other'
    ];
    data.messageType = 'startup';
    data.firmwareVersion = bytes[0] + '.' + bytes[1] + '.' + bytes[2];
    var cause = resetCauses[bytes[3]];
    if (cause !== undefined) {
      data.resetCause = cause;
    }
    data.action = { occupancy: { occupied: (bytes[4] & 0x1) === 0x1 } };
    return { data: data };
  }

  if (input.fPort === 6) {
    // Debug: raw diagnostic bytes; no occupancy field on this message type.
    var raw = [];
    for (var i = 0; i < bytes.length; i++) {
      raw.push(bytes[i]);
    }
    data.messageType = 'debug';
    data.rawBytes = raw;
    return { data: data };
  }

  return { errors: ['unsupported fPort ' + input.fPort] };
}
