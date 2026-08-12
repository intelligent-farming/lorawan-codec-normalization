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
//
// External ports -> reserved `channels[]` (see AUTHORING.md "Multi-channel
// devices"). Elsys carries the external-port index in the TLV type byte itself,
// and the shared Elsys type table pairs every external bank across two ports.
// This device's decoder covers ONE of those banks at both positions -- the
// external pulse counter -- which is what establishes the two-port pair here:
//     bank                      port 1 type      port 2 type
//     pulse counter, relative      0x0a             0x16    (both decoded)
//     pulse counter, absolute      0x0b             --      (0x17 not decoded)
//     analog input (mV)            0x08             --      (0x18 not decoded)
//     external temperature         0x0c             --      (0x19 not decoded)
//     external digital input       0x0d             --      (0x1a not decoded)
// Entry labels use the vendor's own term plus a 0-based index: `port0` = Elsys
// port 1, `port1` = Elsys port 2. Every reading whose TLV type names port 1 is
// scoped into `port0` -- the port index leaves the key name and lives only in
// the entry label -- and no `port1` entry is fabricated for a bank whose port-2
// TLV this decoder does not handle (the entry simply lacks that key):
//     analog1 (0x08)                     -> entry `analogMv` (raw mV; the bare
//        name `analog` would collide with the vocabulary `analog.*` group, and
//        the value is millivolts, not the group's volts)
//     pulse1 (0x0a) / pulse2 (0x16)      -> entry `pulseRelative`
//     pulseAbs (0x0b)                    -> entry `pulseAbsolute` (upstream's
//        unnumbered name is a port-1 alias, not a separate sensor). PULSE1 and
//        PULSE1_ABS are two readings of the *same* counter at port 1 (count
//        since the last uplink, and the lifetime total), so they share one entry
//        -- splitting them would attribute one physical meter to two channels.
//     externalTemperature (0x0c)         -> entry `externalTemperature`
//
// EXT_DIGITAL (0x0d) is the ONE external type held back: on this unit it is not
// a customer-attached generic input but the EMS's own reed/door switch -- the
// whole-device sensor behind action.contactState, which is the `contact`
// category's required key -- so `digital` and action.contactState stay
// top-level. (Contrast the ERS Lite family, where 0x0d/0x1a are a generic
// two-position digital-input bank and do live in the port entries.)
//
// Other whole-device readings stay top-level as well: battery, air.*,
// accelerationX/Y/Z, action.motion, distance, occupancy, water.leak /
// waterLeakLevel, soundPeak / soundAvg. Nothing is emitted both places.
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
  var water = {};
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
      // EXT_DIGITAL, here the EMS's own reed/door switch (whole-device, so it
      // stays top-level rather than in a port entry): 1 byte, 1 = open.
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
      // PULSE2: external port 2 relative pulse count, 2 bytes unsigned.
      portFor(1).pulseRelative = u16be(bytes[i + 1], bytes[i + 2]);
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
  // Omit `channels` entirely when neither external port reported.
  if (channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elsys";
    result.data.model = "ems";
  }
  return result;
}
