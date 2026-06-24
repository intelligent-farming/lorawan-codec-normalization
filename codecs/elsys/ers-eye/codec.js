// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Elsys ERS Eye (indoor multi-sensor that adds
// people-counting / occupancy detection to the ERS base: temperature,
// humidity, light, motion/PIR, occupancy, CO2, etc.).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Elsys typed TLV: type byte then big-endian value) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/elsys/elsys.js, attributed in NOTICE).
//
// Elsys reports battery voltage (VDD, type 0x07) in millivolts; the vocabulary's
// `battery` is volts, so VDD is divided by 1000 into `battery`. Elsys 'motion'
// (type 0x05) is a count of detected movements, mapped to action.motion.count
// with action.motion.detected = count > 0. The ERS Eye 'occupancy' field
// (type 0x11) is a presence indicator, mapped to action.motion.detected (a
// non-zero value means presence). Fields with no vocabulary key (acceleration,
// analog input, external temperature, sound, distance, people-count, etc.) are
// emitted as camelCase extras.

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

function decodeUplinkCore(input) {
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
      motion.count = count;
      if (motion.detected === undefined) {
        motion.detected = count > 0;
      }
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
    } else if (type === 0x0c) {
      // External temperature 1: 2 bytes signed, tenths of a degree. No vocab key.
      data.externalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x0e) {
      // Distance: 2 bytes unsigned, mm. No vocab key -> extra.
      data.distance = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x11) {
      // Occupancy: 1 byte, presence indicator. Non-zero means presence.
      // Maps to action.motion.detected (a boolean). Occupancy is authoritative
      // for `detected`; it overrides a count-derived value if motion (0x05)
      // was already seen.
      motion.detected = bytes[i + 1] > 0;
      action.motion = motion;
      i += 2;
      recognized = true;
    } else if (type === 0x15) {
      // Sound: 2 bytes (peak, average). No vocab key -> extras.
      data.soundPeak = bytes[i + 1];
      data.soundAvg = bytes[i + 2];
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
  if (action.motion !== undefined) {
    data.action = action;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elsys";
    result.data.model = "ers-eye";
  }
  return result;
}
