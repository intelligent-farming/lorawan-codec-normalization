// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dingtek DO200 (Parking Occupancy Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/do200.js, attributed in
// NOTICE). Upstream emits a flat bag of raw fields (level, volt, alarm*,
// x/y/zMagnet); this module normalizes the parking status to
// action.occupancy.occupied and battery voltage to `battery` (V), keeping the
// raw magnetometer/level/alarm fields as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16(hi, lo) {
  var v = (hi << 8) | lo;
  return v & 0x8000 ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 3)'] };
  }
  // 21-byte telemetry frame: parking status + magnetometer + battery. The
  // 17-byte parameter/config frame carries no measurement and is not decoded.
  if (bytes.length !== 21) {
    return { errors: ['expected 21-byte telemetry frame, got ' + bytes.length] };
  }

  var data = {};

  // Byte 7 high nibble: parking-space occupied flag (true = occupied).
  data.action = { occupancy: { occupied: Boolean(bytes[7] >> 4) } };

  // Bytes 9-10: battery voltage, centivolts -> V.
  data.battery = round(((bytes[9] << 8) | bytes[10]) / 100, 2);

  // Bytes 5-6: raw ultrasonic ranging reading (device units).
  data.rangingLevel = (bytes[5] << 8) | bytes[6];

  // Alarm flags (device diagnostics).
  data.levelAlarm = Boolean(bytes[7] & 0x0f);
  data.magnetAlarm = Boolean(bytes[8] >> 4);
  data.batteryAlarm = Boolean(bytes[8] & 0x0f);

  // Bytes 11-16: raw magnetometer XYZ (signed 16-bit).
  data.magnetometerX = s16(bytes[11], bytes[12]);
  data.magnetometerY = s16(bytes[13], bytes[14]);
  data.magnetometerZ = s16(bytes[15], bytes[16]);

  // Bytes 17-18: device frame counter.
  data.frameCounter = (bytes[17] << 8) | bytes[18];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dingtek", model: "do200" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "do200";
  }
  return result;
}
