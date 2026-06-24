// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Mutelcor MTC-CO2-05 (LoRa wireless CO2 sensor:
// CO2 + temperature + relative humidity, with optional pressure, light, TVOC,
// distance, digital inputs and particulate matter).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Mutelcor LoRaButton framing: version, battery/input voltage, OpCode,
// then OpCode-specific body) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices vendor/mutelcor/
// mutelcor.js, attributed in NOTICE). Ported from upstream
// MutelcorLoRaButtonDecode; we author the normalization ourselves and do NOT
// copy upstream normalizeUplink / Descriptions output.
//
// Mutelcor reports the battery/input voltage in centivolts (value / 100), i.e.
// already in volts, so it maps directly to the vocabulary `battery` (V) key.
// Temperature is a signed 16-bit value in tenths of a degree Celsius. CO2,
// light and distance are unsigned 16-bit; relative humidity is one byte.
// Pressure is tenths of a hPa. The vocabulary has no key for TVOC, particulate
// matter, digital inputs, switch state or the message framing fields, so those
// are emitted as camelCase extras (tvoc, pm1_0, pm2_5, pm10, distance,
// digitalInputs, switchState, messageType, payloadVersion).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi * 256) + lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

// Mutelcor OpCode -> camelCase message-type name.
var OPCODES = {
  0: 'heartbeat',
  1: 'alarm',
  2: 'votes',
  3: 'measurements',
  4: 'location',
  5: 'thresholds',
  6: 'switch',
  7: 'reminder',
  80: 'feedback',
  112: 'info',
  113: 'show',
  114: 'update',
  128: 'scd30'
};

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var pos = 0;
  var data = {};
  var air = {};

  // Byte 0: payload version.
  data.payloadVersion = bytes[pos];
  pos += 1;

  // Bytes 1..2: battery / input voltage in centivolts -> volts.
  if (bytes.length < pos + 2) {
    return { errors: ['unexpected end, no (complete) voltage'] };
  }
  data.battery = round(u16be(bytes[pos], bytes[pos + 1]) / 100, 2);
  pos += 2;

  // Byte 3: OpCode (message type).
  if (bytes.length < pos + 1) {
    return { errors: ['unexpected end, no OpCode'] };
  }
  var opcode = bytes[pos];
  pos += 1;

  if (!Object.prototype.hasOwnProperty.call(OPCODES, opcode)) {
    return { errors: ['unknown OpCode ' + opcode] };
  }
  data.messageType = OPCODES[opcode];

  // Measurements (OpCode 3). This is the primary uplink for the CO2 variant.
  // Thresholds (OpCode 5) carries the same measurement block; this codec only
  // normalizes the measurement readings, not the threshold trigger flags.
  if (opcode === 3 || opcode === 5) {
    if (bytes.length < pos + 1) {
      return { errors: ['unexpected end, measurements OpCode requires a measurement bitmask'] };
    }
    var mask = bytes[pos];
    pos += 1;

    if (mask & 1) {
      // Temperature: signed 16-bit, tenths of a degree Celsius.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) temperature value'] };
      }
      air.temperature = round(s16be(bytes[pos], bytes[pos + 1]) / 10, 1);
      pos += 2;
    }
    if (mask & 2) {
      // Relative humidity: one byte, percent.
      if (bytes.length < pos + 1) {
        return { errors: ['unexpected end, no relative humidity value'] };
      }
      air.relativeHumidity = bytes[pos];
      pos += 1;
    }
    if (mask & 4) {
      // Pressure: unsigned 16-bit, tenths of a hPa.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) pressure value'] };
      }
      air.pressure = round(u16be(bytes[pos], bytes[pos + 1]) / 10, 1);
      pos += 2;
    }
    if (mask & 8) {
      // Light: unsigned 16-bit, lux.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) light value'] };
      }
      air.lightIntensity = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 16) {
      // CO2: unsigned 16-bit, ppm.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) CO2 value'] };
      }
      air.co2 = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 32) {
      // TVOC: unsigned 16-bit, ppb. No vocabulary key -> extra.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) TVOC value'] };
      }
      data.tvoc = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 64) {
      // Distance: unsigned 16-bit, mm. No vocabulary key -> extra.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) distance value'] };
      }
      data.distance = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 128) {
      // Extended-measurement byte: a second bitmask for digital inputs / PM.
      if (bytes.length < pos + 1) {
        return { errors: ['unexpected end, no extended measurement bitmask'] };
      }
      var ext = bytes[pos];
      pos += 1;

      if (ext & 1) {
        // Digital inputs: one byte. Low nibble flags which inputs are present;
        // the matching high-nibble bit gives that input's level. No vocabulary
        // key -> camelCase extra keyed by input number.
        if (bytes.length < pos + 1) {
          return { errors: ['unexpected end, no digital inputs value'] };
        }
        var di = bytes[pos];
        pos += 1;
        var digitalInputs = {};
        for (var n = 0; n < 4; n += 1) {
          if (di & (1 << n)) {
            digitalInputs['input' + (n + 1)] = (di & (1 << (n + 4))) !== 0;
          }
        }
        data.digitalInputs = digitalInputs;
      }
      if (ext & 2) {
        // Particulate matter: three unsigned 16-bit values (PM1.0, PM2.5,
        // PM10) in µg/m³. No vocabulary key -> camelCase extras.
        if (bytes.length < pos + 6) {
          return { errors: ['unexpected end, no (complete) particulate matter values'] };
        }
        data.pm1_0 = u16be(bytes[pos], bytes[pos + 1]);
        data.pm2_5 = u16be(bytes[pos + 2], bytes[pos + 3]);
        data.pm10 = u16be(bytes[pos + 4], bytes[pos + 5]);
        pos += 6;
      }
    }

    // A trailing byte after the measurement block is the switch state.
    if (pos + 1 <= bytes.length) {
      data.switchState = bytes[pos] !== 0;
      pos += 1;
    }
  }

  if (air.temperature !== undefined ||
      air.relativeHumidity !== undefined ||
      air.pressure !== undefined ||
      air.lightIntensity !== undefined ||
      air.co2 !== undefined) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mutelcor";
    result.data.model = "mtc-co2-05";
  }
  return result;
}
