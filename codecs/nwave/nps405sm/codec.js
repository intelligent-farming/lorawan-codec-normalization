// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nwave NPS405SM (Smart Parking Sensor G4 SM —
// magnetometer vehicle-detection + onboard temperature).
//
// Decode logic ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/nwave/nps405.js, attributed in
// NOTICE). The upstream wire format is preserved faithfully: the message type
// is selected by FPort — 1 = parking status, 2 = heartbeat, 3 = startup,
// 6 = debug, 10 = SDI tag (user) registration.
//
// Vocabulary mapping: the parking occupancy bit (bytes[0] & 0x1) ->
// action.occupancy.occupied; the compressed previous-state duration (seconds) ->
// action.occupancy.duration; the heartbeat onboard temperature (signed,
// quantized) -> air.temperature; the heartbeat battery voltage (V) -> battery.
// Everything else the device reports — message type, hardware-health byte,
// battery-health classification, the duration quantization error/overflow flags,
// firmware version, reset cause, and the SDI tag id — has no vocabulary key and
// is emitted as camelCase extras.
//
// Faithful quirk preserved from upstream: the SDI registration frame (FPort 10)
// only carries a known occupancy state when its low bit is set; when clear, the
// upstream decoder emits occupied=null. We cannot emit a non-boolean occupancy,
// so in that case action.occupancy is omitted and the registration is reported
// purely via extras (occupancyKnown=false + tagId).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s8(b) {
  return b > 127 ? b - 256 : b;
}

// Expand the 7-bit compressed previous-state duration (upstream
// calculatePreviousState). Returns seconds, the quantization error in seconds
// (null on overflow), and an overflow flag.
function decompressDuration(compressed) {
  var result = { overflow: false, error: 0 };
  if (compressed < 90) {
    result.seconds = compressed;
    result.error = 0;
  } else if (compressed < 120) {
    result.seconds = 90 + (compressed - 90) * 5;
    result.error = 4;
  } else if (compressed < 127) {
    result.seconds = 240 + (compressed - 120) * 60;
    result.error = 59;
  } else {
    result.seconds = 660;
    result.error = null;
    result.overflow = true;
  }
  return result;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var data = {};
  var dur;

  if (input.fPort === 1) {
    // Parking status
    data.messageType = 'parkingStatus';
    data.action = { occupancy: { occupied: (bytes[0] & 0x1) === 0x1 } };
    dur = decompressDuration((bytes[0] >> 1) & 0x7f);
    data.action.occupancy.duration = dur.seconds;
    data.previousStateDurationError = dur.error;
    data.previousStateDurationOverflow = dur.overflow;
    return { data: data };
  }

  if (input.fPort === 2) {
    // Heartbeat
    data.messageType = 'heartbeat';
    data.action = { occupancy: { occupied: (bytes[0] & 0x1) === 0x1 } };
    data.hwHealthStatus = bytes[0] & 0x7f;

    var temperature = s8(bytes[2]) / 2 + 10;
    data.air = { temperature: round(temperature, 1) };

    var batteryMv = 2500 + bytes[1] * 4;
    data.battery = round(batteryMv / 1000, 3);

    var criticalThreshold = temperature >= -5 ? 2900 : 2800;
    var lowThreshold = temperature >= -5 ? 3000 : 2900;
    if (batteryMv >= lowThreshold) {
      data.batteryHealth = 'normal';
    } else if (batteryMv >= criticalThreshold) {
      data.batteryHealth = 'low';
    } else {
      data.batteryHealth = 'critical';
    }
    return { data: data };
  }

  if (input.fPort === 3) {
    // Startup
    data.messageType = 'startup';
    data.firmwareVersion = bytes[0] + '.' + bytes[1] + '.' + bytes[2];
    var resetCauses = [
      'rejoining_lorawan_network',
      'watchdog',
      'power_on',
      'user_request',
      null,
      null,
      'brownout',
      'other'
    ];
    var cause = resetCauses[bytes[3]];
    if (cause) {
      data.resetCause = cause;
    }
    data.action = { occupancy: { occupied: (bytes[4] & 0x1) === 0x1 } };
    return { data: data };
  }

  if (input.fPort === 6) {
    // Debug — raw byte dump, no normalized measurement
    data.messageType = 'debug';
    data.rawBytes = bytes;
    return { data: data };
  }

  if (input.fPort === 10) {
    // SDI tag (user) registration
    data.messageType = 'userRegistration';
    if ((bytes[0] & 0x1) === 0x1) {
      data.action = { occupancy: { occupied: true } };
      dur = decompressDuration((bytes[0] >> 1) & 0x7f);
      data.action.occupancy.duration = dur.seconds;
      data.previousStateDurationError = dur.error;
      data.previousStateDurationOverflow = dur.overflow;
      data.occupancyKnown = true;
    } else {
      // Upstream emits occupied=null here; a non-boolean occupancy is not
      // representable, so omit action.occupancy and flag it as unknown.
      data.occupancyKnown = false;
    }
    var tagId = (bytes[1] << 24 | bytes[2] << 16 | bytes[3] << 8 | bytes[4]) >>> 0;
    data.tagId = tagId.toString(16).toUpperCase();
    return { data: data };
  }

  return { errors: ['unknown FPort'] };
}
