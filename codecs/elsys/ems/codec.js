// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Elsys EMS (mini multisensor: temperature,
// humidity, accelerometer, reed/door switch and water leak).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Elsys typed TLV: type byte then big-endian value) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/elsys/elsys.js, attributed in NOTICE). The byte advancement and
// signed/unsigned decoding below are ported faithfully from that reference's
// DecodeElsysPayload; the normalization to vocabulary keys is authored here and
// is NOT copied from upstream normalizeUplink.
//
// Mapping notes:
//   - Temperature (0x01): 2 bytes signed, tenths of a degree -> air.temperature.
//   - Humidity (0x02): 1 byte percentage -> air.relativeHumidity.
//   - Light (0x04): 2 bytes unsigned lux -> air.lightIntensity.
//   - Motion (0x05): 1 byte count of detected movements -> action.motion.count,
//     with action.motion.detected = count > 0.
//   - CO2 (0x06): 2 bytes unsigned ppm -> air.co2.
//   - Battery voltage VDD (0x07): 2 bytes unsigned mV -> battery (volts, /1000).
//   - External digital input (0x0D): the EMS reed/door switch. 1 (high) = magnet
//     away = door open; 0 (low) = magnet present = door closed. Mapped to the
//     vocabulary enum action.contactState ('open' | 'closed'). The raw value is
//     also kept as the extra `digital`.
//   - Water leak (0x12): 1 byte, 0-255 detection level. Mapped to the boolean
//     water.leak (> 0 = leak detected); the raw level is kept as `waterLeakLevel`.
//   - Fields with no vocabulary key (acceleration, analog inputs, external
//     temperatures, distance, sound, pulse counters, occupancy, etc.) are emitted
//     as camelCase extras.

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

function u32be(b3, b2, b1, b0) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
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
  var water = {};
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
    } else if (type === 0x0a) {
      // Pulse counter 1 (relative): 2 bytes unsigned. No vocab key -> extra.
      data.pulse1 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0b) {
      // Pulse counter 1 (absolute): 4 bytes unsigned. No vocab key -> extra.
      data.pulseAbs = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x0c) {
      // External temperature 1: 2 bytes signed, tenths of a degree. No vocab key.
      data.externalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x0d) {
      // External digital input (EMS reed/door switch): 1 byte, 1 = open, 0 = closed.
      var digital = bytes[i + 1];
      data.digital = digital;
      action.contactState = digital ? 'open' : 'closed';
      i += 2;
      recognized = true;
    } else if (type === 0x0e) {
      // Distance: 2 bytes unsigned, mm. No vocab key -> extra.
      data.distance = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x11) {
      // Occupancy: 1 byte. No vocab key -> extra.
      data.occupancy = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x12) {
      // Water leak: 1 byte, 0-255 detection level. > 0 = leak detected.
      var level = bytes[i + 1];
      water.leak = level > 0;
      data.waterLeakLevel = level;
      i += 2;
      recognized = true;
    } else if (type === 0x15) {
      // Sound: 2 bytes (peak, average). No vocab key -> extras.
      data.soundPeak = bytes[i + 1];
      data.soundAvg = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (type === 0x16) {
      // Pulse counter 2 (relative): 2 bytes unsigned. No vocab key -> extra.
      data.pulse2 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
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
  if (water.leak !== undefined) {
    data.water = water;
  }
  if (action.motion !== undefined || action.contactState !== undefined) {
    data.action = action;
  }

  return { data: data };
}
