// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Elsys EMS Door — a door/window sensor with a
// reed (door) switch for open/closed detection and an accelerometer for
// movement detection.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Ported
// from the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/elsys/elsys.js, attributed in NOTICE) — the shared Elsys typed-TLV
// decoder (type byte then big-endian value). The upstream DecodeElsysPayload
// type/length handling is ported faithfully so the byte stream stays aligned;
// the normalization to the shared vocabulary is authored here (never copied
// from upstream normalizeUplink).
//
// Categories: contact + motion.
//
// Mapping notes:
//   - EXT_DIGITAL (0x0D) is the reed/door switch state -> action.contactState.
//     Elsys reports the digital input as 1 (high) / 0 (low). For a door reed
//     switch, the contact is open when the magnet is away from the sensor (the
//     door is open) -> digital !== 0 maps to "open", 0 maps to "closed".
//   - MOTION (0x05) counts movements detected -> action.motion.count, with
//     action.motion.detected = (count > 0).
//   - ACC_MOTION (0x0F) is the accelerometer-based movement count. When MOTION
//     is absent it also drives action.motion (count/detected); the device emits
//     accelerometer movement through whichever channel its firmware uses.
//   - ACC (0x03) raw X/Y/Z axes have no vocabulary key -> camelCase extras.
//   - VDD (0x07) battery voltage is reported in millivolts; the vocabulary's
//     `battery` is volts, so VDD is divided by 1000 into `battery` (Elsys door
//     sensors typically do not report VDD).
//   - TEMP/RH/LIGHT/CO2 -> air.* where the vocabulary models them.
//   - All other typed fields (analog, pulse counters, external/IR temperature,
//     GPS, distance, occupancy, water leak, sound, TVOC, etc.) have no
//     vocabulary key and are emitted as camelCase extras, matching upstream.

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

function u32be(b3, b2, b1, b0) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function s32be(b3, b2, b1, b0) {
  return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var action = {};
  var motionCount;
  var recognized = false;
  var unknownType = false;

  var i = 0;
  while (i < bytes.length) {
    var type = bytes[i];

    if (type === 0x01) {
      // TEMP: 2 bytes signed, tenths of a degree.
      air.temperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x02) {
      // RH: 1 byte, percentage.
      air.relativeHumidity = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x03) {
      // ACC: 3 bytes signed (X, Y, Z). No vocab key -> extras.
      data.x = s8(bytes[i + 1]);
      data.y = s8(bytes[i + 2]);
      data.z = s8(bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (type === 0x04) {
      // LIGHT: 2 bytes unsigned, lux.
      air.lightIntensity = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x05) {
      // MOTION: 1 byte, count of detected movements -> action.motion.
      motionCount = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x06) {
      // CO2: 2 bytes unsigned, ppm.
      air.co2 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x07) {
      // VDD (battery): 2 bytes unsigned, mV -> volts.
      data.battery = round(u16be(bytes[i + 1], bytes[i + 2]) / 1000, 3);
      i += 3;
      recognized = true;
    } else if (type === 0x08) {
      // ANALOG1: 2 bytes unsigned, mV. No vocab key -> extra.
      data.analog1 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x09) {
      // GPS: 6 bytes (3 lat, 3 long), /10000. Extras (ported faithfully).
      var lat = bytes[i + 1] | (bytes[i + 2] << 8) | (bytes[i + 3] << 16) |
        ((bytes[i + 3] & 0x80) ? (0xff << 24) : 0);
      var lng = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) |
        ((bytes[i + 6] & 0x80) ? (0xff << 24) : 0);
      data.lat = lat / 10000;
      data.long = lng / 10000;
      i += 7;
      recognized = true;
    } else if (type === 0x0a) {
      // PULSE1: 2 bytes relative pulse count. No vocab key -> extra.
      data.pulse1 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0b) {
      // PULSE1_ABS: 4 bytes absolute pulse count. No vocab key -> extra.
      data.pulseAbs = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x0c) {
      // EXT_TEMP1: 2 bytes signed, tenths of a degree. No vocab key -> extra.
      data.externalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x0d) {
      // EXT_DIGITAL: reed/door switch state, 1 byte (1/0) -> action.contactState.
      // digital !== 0 -> door open; 0 -> closed.
      action.contactState = bytes[i + 1] !== 0 ? 'open' : 'closed';
      i += 2;
      recognized = true;
    } else if (type === 0x0e) {
      // EXT_DISTANCE: 2 bytes unsigned, mm. No vocab key -> extra.
      data.distance = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0f) {
      // ACC_MOTION: 1 byte, accelerometer-detected movements -> action.motion.
      var accMotion = bytes[i + 1];
      if (motionCount === undefined) {
        motionCount = accMotion;
      }
      data.accMotion = accMotion;
      i += 2;
      recognized = true;
    } else if (type === 0x10) {
      // IR_TEMP: 4 bytes (internal, external), tenths of a degree. Extras.
      data.irInternalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      data.irExternalTemperature = round(s16be(bytes[i + 3], bytes[i + 4]) / 10, 1);
      i += 5;
      recognized = true;
    } else if (type === 0x11) {
      // OCCUPANCY: 1 byte. No vocab key -> extra.
      data.occupancy = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x12) {
      // WATERLEAK: 1 byte, 0-255 leak level. No vocab key -> extra.
      data.waterleak = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x14) {
      // PRESSURE: 4 bytes; ported faithfully as upstream (raw / 1000) -> extra.
      data.pressure = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]) / 1000;
      i += 5;
      recognized = true;
    } else if (type === 0x15) {
      // SOUND: 2 bytes (peak, average). No vocab key -> extras.
      data.soundPeak = bytes[i + 1];
      data.soundAvg = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (type === 0x16) {
      // PULSE2: 2 bytes relative pulse count. No vocab key -> extra.
      data.pulse2 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x17) {
      // PULSE2_ABS: 4 bytes absolute pulse count. No vocab key -> extra.
      data.pulseAbs2 = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x18) {
      // ANALOG2: 2 bytes unsigned, mV. No vocab key -> extra.
      data.analog2 = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x19) {
      // EXT_TEMP2: 2 bytes signed, tenths of a degree. No vocab key -> extra.
      data.externalTemperature2 = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x1a) {
      // EXT_DIGITAL2: 1 byte (1/0). No vocab key -> extra.
      data.digital2 = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x1b) {
      // EXT_ANALOG_UV: 4 bytes, signed uV. No vocab key -> extra.
      data.analogUv = s32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x1c) {
      // TVOC: 2 bytes, ppb. No vocab key -> extra.
      data.tvoc = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else {
      // Unknown / unsupported type: stop to avoid misaligned decoding (matches
      // upstream skipping to the end of the stream on an unrecognized type).
      unknownType = true;
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Elsys fields'] };
  }

  if (motionCount !== undefined) {
    action.motion = { detected: motionCount > 0, count: motionCount };
  }

  if (air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.lightIntensity !== undefined ||
    air.co2 !== undefined) {
    data.air = air;
  }

  if (action.contactState !== undefined || action.motion !== undefined) {
    data.action = action;
  }

  var result = { data: data };
  if (unknownType) {
    result.warnings = ['stopped at unrecognized Elsys type; later fields skipped'];
  }
  return result;
}
