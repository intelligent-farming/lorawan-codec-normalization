// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Elsys ERS CO2 Lite (indoor environment sensor:
// temperature, humidity and CO2).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Elsys typed TLV: type byte then big-endian value) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/elsys/elsys.js, attributed in NOTICE). Ported from that decoder's
// DecodeElsysPayload / decodeUplink type table; the upstream normalizeUplink is
// NOT used (it silently drops CO2 -- a known upstream bug -- and never emits
// battery or pressure).
//
// Mapping to the shared vocabulary: temperature -> air.temperature; humidity ->
// air.relativeHumidity; co2 -> air.co2 (ppm); light -> air.lightIntensity
// (lux); motion -> action.motion.count with .detected = count > 0; pressure
// (reported in hPa) -> air.pressure; battery voltage (VDD) is millivolts -> the
// vocabulary `battery` (volts) by dividing by 1000. Elsys fields with no
// vocabulary key (acceleration, analog/pulse inputs, external/IR temperature,
// distance, sound, occupancy, water leak, TVOC, etc.) are emitted as camelCase
// extras. The ERS CO2 Lite hardware reports temperature, humidity and CO2; the
// rest of the Elsys type table is ported for faithfulness and robustness.
//
// External ports -> reserved `channels[]` (see AUTHORING.md "Multi-channel
// devices"). Elsys carries the external-port index in the TLV type byte itself,
// and this decoder covers all FIVE external banks at BOTH positions -- every one
// of them is a numbered pair:
//     bank                    port 1 type   port 2 type
//     analog input (mV)          0x08          0x18
//     pulse counter, relative    0x0a          0x16
//     pulse counter, absolute    0x0b          0x17
//     external temperature       0x0c          0x19
//     external digital input     0x0d          0x1a
// The two ports are the same physical quantities at two physical positions, so
// each port becomes one `channels[]` entry instead of a suffixed extra. Entry
// labels use the vendor's own term plus a 0-based index: `port0` = Elsys port 1
// (types 0x08/0x0a/0x0b/0x0c/0x0d), `port1` = Elsys port 2 (types
// 0x18/0x16/0x17/0x19/0x1a).
//
// The port index therefore leaves the key name and lives only in the entry
// label, so both entries carry the *same* keys -- mappings are unchanged from
// the pre-channels codec, only relocated. Note that upstream's *unnumbered*
// names for the port-1 banks (`pulseAbs` for 0x0b, `digital` for 0x0d,
// `externalTemperature` for 0x0c) are aliases for port 1, not separate sensors,
// so they move into `port0`:
//     analog1 / analog2                  -> entry `analogMv` (raw mV; the bare
//        name `analog` would collide with the vocabulary `analog.*` group, and
//        the value is millivolts, not the group's volts)
//     pulse1 / pulse2                    -> entry `pulseRelative`
//     pulseAbs / pulseAbs2               -> entry `pulseAbsolute`
//     externalTemperature / ...2         -> entry `externalTemperature`
//     digital / digital2                 -> entry `digital` (raw 1/0)
// Whole-device readings stay top-level: battery, air.* (temperature,
// relativeHumidity, co2, lightIntensity, pressure), accelerationX/Y/Z,
// action.motion, accMotion, distance, occupancy, waterleak, soundPeak /
// soundAvg, tvoc. Nothing is emitted both places.
//
// Sentinel/absent-port policy: an Elsys TLV stream is sparse -- a port's TLV is
// simply absent when nothing is attached to it (there is no disconnected
// sentinel value), so entries are built lazily on first sight. A port that
// reported no reading gets no entry, and `channels` is omitted entirely when
// neither port reported. Entry order follows the payload.

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

  // One `channels[]` entry per external port, created on first sight so entry
  // order follows the payload and an unused port produces no entry.
  var channels = [];
  var portSlot = {};

  function portFor(port) {
    var label = 'port' + port;
    if (portSlot[label] === undefined) {
      portSlot[label] = channels.length;
      channels.push({ channel: label });
    }
    return channels[portSlot[label]];
  }

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
      // ANALOG1: external port 1 analog input, 2 bytes unsigned, mV.
      portFor(0).analogMv = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0a) {
      // PULSE1: external port 1 relative pulse count, 2 bytes unsigned.
      portFor(0).pulseRelative = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0b) {
      // PULSE1_ABS: external port 1 absolute pulse count, 4 bytes unsigned.
      portFor(0).pulseAbsolute = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x0c) {
      // EXT_TEMP1: external port 1 probe, 2 bytes signed, tenths of a degree.
      portFor(0).externalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x0d) {
      // EXT_DIGITAL: external port 1 digital input, 1 byte (0/1).
      portFor(0).digital = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x0e) {
      // Distance: 2 bytes unsigned, mm. No vocab key -> extra.
      data.distance = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0f) {
      // Acceleration-based motion detection: 1 byte count. No vocab key -> extra.
      data.accMotion = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x11) {
      // Occupancy: 1 byte. No vocab key -> extra.
      data.occupancy = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x12) {
      // Water leak: 1 byte (0-255 leak strength). No vocab key -> extra.
      data.waterleak = bytes[i + 1];
      i += 2;
      recognized = true;
    } else if (type === 0x14) {
      // Pressure: 4 bytes unsigned, value/1000 = hPa (atmospheric).
      air.pressure = round(u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]) / 1000, 2);
      i += 5;
      recognized = true;
    } else if (type === 0x15) {
      // Sound: 2 bytes (peak, average). No vocab key -> extras.
      data.soundPeak = bytes[i + 1];
      data.soundAvg = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (type === 0x16) {
      // PULSE2: external port 2 relative pulse count, 2 bytes unsigned.
      portFor(1).pulseRelative = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x17) {
      // PULSE2_ABS: external port 2 absolute pulse count, 4 bytes unsigned.
      portFor(1).pulseAbsolute = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x18) {
      // ANALOG2: external port 2 analog input, 2 bytes unsigned, mV.
      portFor(1).analogMv = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x19) {
      // EXT_TEMP2: external port 2 probe, 2 bytes signed, tenths of a degree.
      portFor(1).externalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x1a) {
      // EXT_DIGITAL2: external port 2 digital input, 1 byte (0/1).
      portFor(1).digital = bytes[i + 1];
      i += 2;
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
  // Omit `channels` entirely when neither external port reported.
  if (channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "elsys", model: "ers-co2-lite" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elsys";
    result.data.model = "ers-co2-lite";
  }
  return result;
}
