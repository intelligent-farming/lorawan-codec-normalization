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
//   - EXT_DIGITAL (0x0D) is the reed/door switch state -> action.contactState
//     (inside the `port0` channels entry, see below). Elsys reports the digital
//     input as 1 (high) / 0 (low). For a door reed switch, the contact is open
//     when the magnet is away from the sensor (the door is open) -> digital !== 0
//     maps to "open", 0 maps to "closed".
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
//
// External ports -> reserved `channels[]` (see AUTHORING.md "Multi-channel
// devices"). The EMS Door exposes TWO external ports (the door reed hangs off
// port 1), and Elsys carries the port index in the TLV type itself — every
// external bank is a numbered pair:
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
// 0x18/0x16/0x17/0x19/0x1a). A port can carry several quantities at once, so one
// entry may hold e.g. action.contactState, externalTemperature and a pulse
// count together.
//
// The port index therefore leaves the key name and lives only in the entry
// label, so both entries carry the *same* keys — mappings are unchanged from
// the pre-channels codec, only relocated. Note that upstream's *unnumbered*
// names for the port-1 banks (`digital` for 0x0d, `pulseAbs` for 0x0b) are
// aliases for port 1, not separate sensors, so they move into `port0`:
//     digital (0x0d) / digital2 (0x1a)   -> entry `action.contactState`; port 2
//        is a second dry contact, so it gets the same vocabulary key the door
//        reed already used rather than a raw suffixed `digital2` extra
//     analog1 / analog2                  -> entry `analogMv` (raw mV; the bare
//        name `analog` would collide with the vocabulary `analog.*` group, and
//        the value is millivolts, not the group's volts)
//     pulse1 / pulse2                    -> entry `pulseRelative`
//     pulseAbs / pulseAbs2               -> entry `pulseAbsolute`
//     externalTemperature / ...2         -> entry `externalTemperature`
// The look-alike sibling 0x1b (EXT_ANALOG_UV, µV load-cell/UV input) is a
// distinct unpaired sensor, not port 2 of the analog bank, so `analogUv` stays
// top-level. Whole-device readings stay top-level too: battery, air.*, x/y/z,
// accMotion and action.motion (the onboard accelerometer belongs to the device,
// not to a port), pressure, distance, IR/GPS/sound/occupancy/water-leak/TVOC.
// Nothing is emitted both places — with the reed scoped to `port0`, the
// top-level `action` group carries motion only. The `contact` category is still
// satisfied, since membership sees top-level channels entries.
//
// Sentinel/absent-port policy: an Elsys TLV stream is sparse — a port's TLV is
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

function decodeUplinkCore(input) {
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

  // The entry's `action` group is created lazily so a port reporting only a
  // pulse count or probe temperature carries no empty `action: {}`.
  function portAction(port) {
    var entry = portFor(port);
    if (entry.action === undefined) {
      entry.action = {};
    }
    return entry.action;
  }

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
      // ANALOG1: external port 1 analog input, 2 bytes unsigned, mV.
      portFor(0).analogMv = u16be(bytes[i + 1], bytes[i + 2]);
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
      // PULSE1: external port 1 relative pulse count, 2 bytes.
      portFor(0).pulseRelative = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x0b) {
      // PULSE1_ABS: external port 1 absolute pulse count, 4 bytes.
      portFor(0).pulseAbsolute = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else if (type === 0x0c) {
      // EXT_TEMP1: external port 1 probe, 2 bytes signed, tenths of a degree.
      portFor(0).externalTemperature = round(s16be(bytes[i + 1], bytes[i + 2]) / 10, 1);
      i += 3;
      recognized = true;
    } else if (type === 0x0d) {
      // EXT_DIGITAL: external port 1 dry contact — the reed/door switch on this
      // model — 1 byte (1/0) -> action.contactState in the `port0` entry.
      // digital !== 0 -> door open; 0 -> closed.
      portAction(0).contactState = bytes[i + 1] !== 0 ? 'open' : 'closed';
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
      // PULSE2: external port 2 relative pulse count, 2 bytes.
      portFor(1).pulseRelative = u16be(bytes[i + 1], bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (type === 0x17) {
      // PULSE2_ABS: external port 2 absolute pulse count, 4 bytes.
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
      // EXT_DIGITAL2: external port 2 dry contact, 1 byte (1/0) — same quantity
      // as port 1, so the same vocabulary key inside the `port1` entry.
      portAction(1).contactState = bytes[i + 1] !== 0 ? 'open' : 'closed';
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

  // The top-level `action` group carries motion only — the contact state is
  // port-scoped and lives in its channels entry.
  if (action.motion !== undefined) {
    data.action = action;
  }
  // Omit `channels` entirely when neither external port reported.
  if (channels.length > 0) {
    data.channels = channels;
  }

  var result = { data: data };
  if (unknownType) {
    result.warnings = ['stopped at unrecognized Elsys type; later fields skipped'];
  }
  return result;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "elsys", model: "ems-door" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elsys";
    result.data.model = "ems-door";
  }
  return result;
}
