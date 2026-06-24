// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Mutelcor MTC-AQB01 (LoRa Air Quality Button:
// service/emergency button plus wireless air-quality measurements —
// temperature, relative humidity, and, depending on the fitted sensor head,
// CO2 / TVOC / particulate matter).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Mutelcor LoRaButton payload: version + battery voltage + opcode,
// then per-opcode fields) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/mutelcor/mutelcor.js,
// attributed in NOTICE). Ported from that decoder's `MutelcorLoRaButtonDecode`,
// keeping its byte layout and decode-error semantics; this device only carries
// the climate / air-quality opcodes (Heartbeat, Alarm, Measurements,
// Thresholds, Switch, Reminder, SCD30), so the long config/show/update opcodes
// are not modelled.
//
// Mapping to the shared vocabulary:
//   temp        -> air.temperature        (°C, 0.1 resolution)
//   rh          -> air.relativeHumidity   (%)
//   press       -> air.pressure           (hPa)
//   light       -> air.lightIntensity     (lux)
//   co2         -> air.co2                (ppm)
//   voltage     -> battery                (V; header field is already volts)
// The vocabulary has no key for TVOC, particulate matter, distance, switch
// state, or button presses, so those are surfaced as camelCase extras:
//   messageType, payloadVersion, buttons, alarmId, switchState, tvoc,
//   distance, digitalInputs, pm1_0, pm2_5, pm10, thresholdsTriggered,
//   thresholdsStopped, scd30Result.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var OPCODE_NAMES = {
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

function bitmaskList(mask, count) {
  var out = [];
  for (var i = 0; i < count; i += 1) {
    if (mask & (1 << i)) out.push('' + (i + 1));
  }
  return out;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var pos = 0;

  if (bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var extras = {};

  // [version][voltage hi][voltage lo][opcode]
  var version = bytes[pos++];
  extras.payloadVersion = version;

  if (bytes.length < pos + 2) {
    return { errors: ['unexpected end, no (complete) voltage'] };
  }
  // Header field is battery/input voltage in volts (raw / 100).
  data.battery = round((bytes[pos++] * 256 + bytes[pos++]) / 100, 2);

  if (bytes.length < pos + 1) {
    return { errors: ['unexpected end, no OpCode'] };
  }
  var opcode = bytes[pos++];
  if (OPCODE_NAMES[opcode] === undefined) {
    return { errors: ['unknown OpCode ' + opcode] };
  }
  extras.messageType = OPCODE_NAMES[opcode];

  // Opcode 1: Alarm (button press). Buttons bitmask + optional alarm id.
  if (opcode === 1) {
    if (pos < bytes.length && pos + 2 !== bytes.length) {
      extras.buttons = bitmaskList(bytes[pos++], 8);
    }
    if (pos + 1 < bytes.length) {
      extras.alarmId = bytes[pos++] * 256 + bytes[pos++];
    }
  }

  // Opcode 3: Measurements, Opcode 5: Thresholds. Both carry a measurements
  // bitmask followed by the present readings, in fixed bit order.
  if (opcode === 3 || opcode === 5) {
    if (bytes.length < pos + 1) {
      return { errors: ['unexpected end, OpCode Measurements/Thresholds requires Measurements'] };
    }
    var measurements = bytes[pos++];

    if (measurements & 1) {
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, measurements without (complete) Temperature value'] };
      }
      // 16-bit signed, value/10 °C (upstream: (raw << 16) / 655360).
      var traw = bytes[pos++] * 256 + bytes[pos++];
      if (traw > 0x7fff) traw -= 0x10000;
      air.temperature = round(traw / 10, 1);
    }
    if (measurements & 2) {
      if (bytes.length < pos + 1) {
        return { errors: ['unexpected end, measurements without Relative Humidity value'] };
      }
      air.relativeHumidity = bytes[pos++];
    }
    if (measurements & 4) {
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, measurements without (complete) Pressure value'] };
      }
      air.pressure = round((bytes[pos++] * 256 + bytes[pos++]) / 10, 1);
    }
    if (measurements & 8) {
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, measurements without (complete) Light value'] };
      }
      air.lightIntensity = bytes[pos++] * 256 + bytes[pos++];
    }
    if (measurements & 16) {
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, measurements without (complete) CO2 value'] };
      }
      air.co2 = bytes[pos++] * 256 + bytes[pos++];
    }
    if (measurements & 32) {
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, measurements without (complete) TVOC value'] };
      }
      extras.tvoc = bytes[pos++] * 256 + bytes[pos++];
    }
    if (measurements & 64) {
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, measurements without (complete) Distance value'] };
      }
      extras.distance = bytes[pos++] * 256 + bytes[pos++];
    }
    if (measurements & 128) {
      if (bytes.length < pos + 1) {
        return { errors: ['unexpected end, measurements without more Measurements'] };
      }
      var extended = bytes[pos++];
      if (extended & 1) {
        if (bytes.length < pos + 1) {
          return { errors: ['unexpected end, measurements without Digital Inputs'] };
        }
        var di = bytes[pos++];
        var dinputs = {};
        for (var d = 0; d < 4; d += 1) {
          if (di & (1 << d)) {
            dinputs['' + (d + 1)] = (di & (1 << (d + 4))) !== 0;
          }
        }
        extras.digitalInputs = dinputs;
      }
      if (extended & 2) {
        if (bytes.length < pos + 6) {
          return { errors: ['unexpected end, measurements without (complete) Particulate Matter'] };
        }
        extras.pm1_0 = bytes[pos++] * 256 + bytes[pos++];
        extras.pm2_5 = bytes[pos++] * 256 + bytes[pos++];
        extras.pm10 = bytes[pos++] * 256 + bytes[pos++];
      }
    }

    if (opcode === 5) {
      if (bytes.length < pos + 1) {
        return { errors: ['unexpected end, OpCode Thresholds requires Threshold info'] };
      }
      var ti = bytes[pos++];
      var triggered = bitmaskList(ti & 0x0f, 4);
      if (triggered.length > 0) extras.thresholdsTriggered = triggered;
      var stopped = bitmaskList(ti >> 4, 4);
      if (stopped.length > 0) extras.thresholdsStopped = stopped;
    }

    // Optional trailing switch-state byte.
    if (pos + 1 <= bytes.length) {
      extras.switchState = bytes[pos++];
    }
  }

  // Opcode 6 (Switch) / 7 (Reminder): single switch-state byte.
  if (opcode === 6 || opcode === 7) {
    if (bytes.length < pos + 1) {
      return { errors: ['unexpected end, OpCode Switch/Reminder requires Switch State'] };
    }
    extras.switchState = bytes[pos++];
  }

  // Opcode 128 (SCD30): single result byte.
  if (opcode === 128) {
    if (bytes.length < pos + 1) {
      return { errors: ['unexpected end, OpCode SCD30 requires SCD30 Result'] };
    }
    extras.scd30Result = bytes[pos++];
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined ||
      air.co2 !== undefined || air.pressure !== undefined ||
      air.lightIntensity !== undefined) {
    data.air = air;
  }

  for (var key in extras) {
    if (extras.hasOwnProperty(key)) data[key] = extras[key];
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mutelcor";
    result.data.model = "mtc-aqb01";
  }
  return result;
}
