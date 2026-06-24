// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Nwave Smart Parking Sensor G4 FM
// (nps405fm): a magnetometer/radar parking-space sensor reporting a persistent
// occupied-vs-vacant state, plus periodic heartbeat (battery + temperature),
// startup, and SDI tag-registration frames. The message type is selected by
// fPort (1 = parking status, 2 = heartbeat, 3 = startup, 6 = debug, 10 = SDI
// tag registration).
//
// The wire format (per-fPort framing; occupied = bit 0 of byte[0]; the 7-bit
// companded "previous state duration" in bits 1..7 of byte[0]; heartbeat
// battery = 2500 + byte[1]*4 mV and signed temperature byte[2]/2 + 10 °C;
// startup firmware/reset-cause; tag-registration 4-byte tag id) was ported
// from and decoded against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/nwave/nps405.js, attributed in
// NOTICE). The upstream field extraction is reproduced faithfully; only the
// JSON shape is re-authored to the normalized vocabulary (never the upstream
// normalizeUplink/normalizedOutput).
//
// Normalization decisions:
//   - Occupied/vacant state -> action.occupancy.occupied (boolean). This is the
//     occupancy category's required key and is emitted on every frame that
//     carries a determinate state (parking status, heartbeat, startup, and an
//     SDI registration that captured a state).
//   - Heartbeat air temperature -> air.temperature (°C).
//   - Heartbeat battery voltage -> battery (V); upstream computes millivolts
//     (2500 + byte[1]*4), divided by 1000 here.
//   - Message type, hardware-health status, firmware version, reset cause, SDI
//     tag id, battery-health classification, and the companded previous-state
//     duration / its error band / overflow flag -> camelCase extras. The
//     previous-state duration describes the PRIOR occupancy state, not the
//     current one, so it is NOT mapped to action.occupancy.duration (which is
//     time held in the CURRENT state); it is kept faithfully as an extra.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Companding of the 7-bit "previous state duration" code, verbatim from the
// upstream decoder. Returns { minutes, errorMinutes (null on overflow),
// overflow }.
function decodePreviousStateDuration(code) {
  var result = { minutes: null, errorMinutes: 0, overflow: false };
  if (code < 90) {
    result.minutes = code;
    result.errorMinutes = 0;
  } else if (code >= 90 && code < 120) {
    result.minutes = 90 + (code - 90) * 5;
    result.errorMinutes = 4;
  } else if (code >= 120 && code < 127) {
    result.minutes = 240 + (code - 120) * 60;
    result.errorMinutes = 59;
  } else if (code === 127) {
    result.minutes = 660;
    result.errorMinutes = null;
    result.overflow = true;
  }
  return result;
}

var RESET_CAUSES = [
  'rejoining_lorawan_network',
  'watchdog',
  'power_on',
  'user_request',
  null,
  null,
  'brownout',
  'other'
];

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var prev;
  var fPort = input.fPort;

  if (fPort === 1) {
    // Parking status.
    data.messageType = 'parkingStatus';
    data.action = { occupancy: { occupied: (bytes[0] & 0x1) === 0x1 } };
    prev = decodePreviousStateDuration((bytes[0] >> 1) & 0x7f);
    data.previousStateDurationMinutes = prev.minutes;
    data.previousStateDurationErrorMinutes = prev.errorMinutes;
    data.previousStateDurationOverflow = prev.overflow;
    return { data: data };
  }

  if (fPort === 2) {
    // Heartbeat.
    if (bytes.length < 3) {
      return { errors: ['heartbeat payload too short'] };
    }
    data.messageType = 'heartbeat';
    data.action = { occupancy: { occupied: (bytes[0] & 0x1) === 0x1 } };
    data.hwHealthStatus = bytes[0] & 0x7f;

    var tempByte = bytes[2] > 127 ? bytes[2] - 256 : bytes[2];
    data.air = { temperature: round(tempByte / 2 + 10, 1) };

    var batteryMv = 2500 + bytes[1] * 4;
    data.battery = round(batteryMv / 1000, 3);

    var criticalThreshold;
    var lowThreshold;
    if (data.air.temperature >= -5) {
      criticalThreshold = 2900;
      lowThreshold = 3000;
    } else {
      criticalThreshold = 2800;
      lowThreshold = 2900;
    }
    if (batteryMv >= lowThreshold) {
      data.batteryHealth = 'normal';
    } else if (batteryMv >= criticalThreshold) {
      data.batteryHealth = 'low';
    } else {
      data.batteryHealth = 'critical';
    }
    return { data: data };
  }

  if (fPort === 3) {
    // Startup.
    if (bytes.length < 5) {
      return { errors: ['startup payload too short'] };
    }
    data.messageType = 'startup';
    data.firmwareVersion = bytes[0] + '.' + bytes[1] + '.' + bytes[2];
    data.resetCause = RESET_CAUSES[bytes[3]];
    data.action = { occupancy: { occupied: (bytes[4] & 0x1) === 0x1 } };
    return { data: data };
  }

  if (fPort === 10) {
    // SDI tag registration.
    if (bytes.length < 5) {
      return { errors: ['tag registration payload too short'] };
    }
    data.messageType = 'tagRegistration';
    if ((bytes[0] & 0x1) === 0x1) {
      data.action = { occupancy: { occupied: true } };
      prev = decodePreviousStateDuration((bytes[0] >> 1) & 0x7f);
      data.previousStateDurationMinutes = prev.minutes;
      data.previousStateDurationErrorMinutes = prev.errorMinutes;
      data.previousStateDurationOverflow = prev.overflow;
    }
    // Tag id: 4 big-endian bytes as an uppercase hex string.
    var tagId = (
      ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0
    ).toString(16).toUpperCase();
    data.tagId = tagId;
    return { data: data };
  }

  if (fPort === 6) {
    return { errors: ['debug frame carries no normalized measurement'] };
  }

  return { errors: ['unsupported fPort ' + fPort] };
}
