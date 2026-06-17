// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Elsys EMS Lite (compact multisensor:
// temperature, humidity, motion/PIR — plus the shared Elsys digital-input and
// battery fields).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Elsys typed TLV: type byte then big-endian value) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/elsys/elsys.js, attributed in NOTICE). Ported from that upstream
// DecodeElsysPayload type handlers; upstream normalizeUplink is NOT copied (it
// drops the digital-input / door channel and forces no contactState).
//
// Mapping notes:
//   * Temperature (0x01): 2 bytes signed, tenths of a degree -> air.temperature.
//   * Relative humidity (0x02): 1 byte percent -> air.relativeHumidity.
//   * Light (0x04): 2 bytes unsigned lux -> air.lightIntensity.
//   * Motion (0x05): 1 byte count of detected movements -> action.motion.count,
//     with action.motion.detected = count > 0.
//   * External digital input (0x0d): 1 byte, the door/reed contact. Input high
//     (1) means the reed contact is closed (magnet present) -> 'closed'; low (0)
//     -> 'open'. Mapped to action.contactState (NOT motion).
//   * CO2 (0x06): 2 bytes unsigned ppm -> air.co2.
//   * Battery voltage VDD (0x07): 2 bytes unsigned mV; the vocabulary's
//     `battery` is volts, so divided by 1000 into `battery`.
//   * Accelerometer (0x03) and analog input 1 (0x08) have no vocabulary key and
//     are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16be(hi, lo) {
  var v = ((hi << 8) | lo) & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s8(b) {
  var v = b & 0xff;
  return v > 0x7f ? v - 0x100 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var action = {};
  var motion = {};
  var recognized = false;

  var i = 0;
  while (i < bytes.length) {
    var type = bytes[i];

    if (type === 0x01) {
      // Temperature: 2 bytes signed, tenths of a degree.
      air.temperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x02) {
      // Relative humidity: 1 byte, percentage.
      air.relativeHumidity = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x03) {
      // Accelerometer: 3 bytes signed (X, Y, Z). No vocab key -> extras.
      data.accelerationX = s8(bytes[i + 1]);
      data.accelerationY = s8(bytes[i + 2]);
      data.accelerationZ = s8(bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (type === 0x04) {
      // Light: 2 bytes unsigned, lux.
      air.lightIntensity = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x05) {
      // Motion: 1 byte, count of detected movements.
      var count = bytes[i + 1];
      motion.detected = count > 0;
      motion.count = count;
      action.motion = motion;
      i += 2;
      recognized = true;
    } else if (type === 0x06) {
      // CO2: 2 bytes unsigned, ppm.
      air.co2 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x07) {
      // Battery voltage (VDD): 2 bytes unsigned, mV -> volts.
      data.battery = round(u16be(bytes[i + 1], bytes[i + 2]) / 1000, 3);
      i += 3;
      recognized = true;
    } else if (type === 0x08) {
      // Analog input 1: 2 bytes unsigned, mV. No vocab key -> extra.
      data.analog1 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0d) {
      // External digital input (door/reed): 1 byte, high (1) = contact closed.
      action.contactState = bytes[i + 1] !== 0 ? 'closed' : 'open';
      i += 2;
      recognized = true;
    } else {
      // Unknown / unsupported type: stop to avoid misaligned decoding.
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Elsys fields'] };
  }

  if (air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.lightIntensity !== undefined ||
    air.co2 !== undefined) {
    data.air = air;
  }
  if (action.motion !== undefined || action.contactState !== undefined) {
    data.action = action;
  }

  return { data: data };
}
