// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Elsys ELT-2 (analog/digital IO sensor with
// onboard temperature + humidity and external probe/analog/digital inputs).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Elsys typed TLV: type byte then big-endian value) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/elsys/elsys.js, attributed in NOTICE). Ported faithfully from that
// decoder's DecodeElsysPayload type handling; normalization authored here.
//
// Normalization notes:
//   - Onboard temperature (type 0x01) -> air.temperature; onboard humidity
//     (0x02) -> air.relativeHumidity; light (0x04) -> air.lightIntensity;
//     CO2 (0x06) -> air.co2.
//   - Battery voltage (VDD, type 0x07) is reported in millivolts; the
//     vocabulary `battery` is volts, so VDD is divided by 1000 into `battery`.
//   - Motion (type 0x05 / acc-motion 0x0f) is a count of detected movements,
//     mapped to action.motion.count with action.motion.detected = count > 0.
//   - Pressure (type 0x14) decodes to hPa (raw / 1000). It is emitted as
//     air.pressure only when atmospheric (900-1100 hPa); otherwise the decoded
//     value is preserved as the camelCase extra `pressureHpa`.
//   - The ELT-2's external temperature probe (types 0x0c/0x19/0x10) is a
//     general-purpose probe, not specifically a water probe, so it is emitted
//     as the camelCase extra `externalTemperature` (no clear water mapping).
//   - All other fields with no vocabulary key (acceleration, analog/digital
//     inputs, distance, pulse counters, GPS, occupancy, water-leak strength,
//     sound, TVOC, UV) are emitted as camelCase extras.

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

function u32be(b0, b1, b2, b3) {
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
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
      // Relative humidity: 1 byte, percentage 0-100.
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
    } else if (type === 0x09) {
      // GPS: 6 bytes (3 lat, 3 long), signed, /10000 deg. No vocab key -> extras.
      var lat = (bytes[i + 1] | (bytes[i + 2] << 8) | (bytes[i + 3] << 16) |
        ((bytes[i + 3] & 0x80) ? (0xff << 24) : 0)) / 10000;
      var lon = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) |
        ((bytes[i + 6] & 0x80) ? (0xff << 24) : 0)) / 10000;
      data.gpsLatitude = lat;
      data.gpsLongitude = lon;
      i += 7;
      recognized = true;
    } else if (type === 0x0a) {
      // Pulse counter 1 (relative): 2 bytes. No vocab key -> extra.
      data.pulse1 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0b) {
      // Pulse counter 1 (absolute): 4 bytes. No vocab key -> extra.
      data.pulse1Absolute = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x0c) {
      // External temperature 1: 2 bytes signed, tenths of a degree. No vocab key.
      data.externalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x0d) {
      // External digital input 1: 1 byte, 0/1. No vocab key -> extra.
      data.digital1 = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x0e) {
      // Distance: 2 bytes unsigned, mm. No vocab key -> extra.
      data.distance = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0f) {
      // Accelerometer-based motion: 1 byte, count of detected movements.
      var accCount = bytes[i + 1];
      motion.detected = accCount > 0;
      motion.count = accCount;
      action.motion = motion;
      i += 2;
      recognized = true;
    } else if (type === 0x10) {
      // IR temperature: 4 bytes (internal, external), tenths of a degree.
      data.irInternalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      data.irExternalTemperature = round(s16be(bytes[i + 3], bytes[i + 4]) / 10, 1);
      i += 5;
      recognized = true;
    } else if (type === 0x11) {
      // Occupancy: 1 byte. No vocab key -> extra.
      data.occupancy = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x12) {
      // Water leak: 1 byte, 0-255 strength. No vocab key -> extra.
      data.waterLeak = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x14) {
      // Pressure: 4 bytes, raw / 1000 = hPa. Emit air.pressure only when
      // atmospheric (900-1100 hPa); otherwise preserve as an extra.
      var hpa = round(u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]) / 1000, 3);
      if (hpa >= 900 && hpa <= 1100) {
        air.pressure = hpa;
      } else {
        data.pressureHpa = hpa;
      }
      i += 5;
      recognized = true;
    } else if (type === 0x15) {
      // Sound: 2 bytes (peak, average). No vocab key -> extras.
      data.soundPeak = bytes[i + 1];
      data.soundAvg = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (type === 0x16) {
      // Pulse counter 2 (relative): 2 bytes. No vocab key -> extra.
      data.pulse2 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x17) {
      // Pulse counter 2 (absolute): 4 bytes. No vocab key -> extra.
      data.pulse2Absolute = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x18) {
      // Analog input 2: 2 bytes unsigned, mV. No vocab key -> extra.
      data.analog2 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x19) {
      // External temperature 2: 2 bytes signed, tenths of a degree. No vocab key.
      data.externalTemperature2 = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x1a) {
      // External digital input 2: 1 byte, 0/1. No vocab key -> extra.
      data.digital2 = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x1b) {
      // External analog UV: 4 bytes signed, microvolts. No vocab key -> extra.
      data.analogUv = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]) | 0;
      i += 5;
      recognized = true;
    } else if (type === 0x1c) {
      // TVOC: 2 bytes unsigned, ppb. No vocab key -> extra.
      data.tvoc = u16be(bytes[i + 1], bytes[i + 2]);
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
    air.co2 !== undefined ||
    air.pressure !== undefined) {
    data.air = air;
  }
  if (action.motion !== undefined) {
    data.action = action;
  }

  return { data: data };
}
