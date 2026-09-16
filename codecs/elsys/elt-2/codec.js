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
//   - The ELT-2's external temperature probes (types 0x0c/0x19) are
//     general-purpose probes, not specifically water probes, so they are
//     emitted as the camelCase extra `externalTemperature` (no clear water
//     mapping). IR temperature (0x10) is a separate non-contact sensor, not one
//     of these probes, and stays top-level as irInternal/irExternalTemperature.
//   - All other fields with no vocabulary key (acceleration, analog/digital
//     inputs, distance, pulse counters, GPS, occupancy, water-leak strength,
//     sound, TVOC, UV) are emitted as camelCase extras.
//
// External ports -> reserved `channels[]` (see AUTHORING.md "Multi-channel
// devices"). The ELT-2 exposes TWO external ports, and Elsys carries the port
// index in the TLV type itself — every external bank is a numbered pair:
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
// label, so both entries carry the *same* keys — mappings are unchanged from
// the pre-channels codec, only relocated:
//     analog1 / analog2                  -> entry `analogMv` (raw mV; the bare
//        name `analog` would collide with the vocabulary `analog.*` group, and
//        the value is millivolts, not the group's volts)
//     pulse1 / pulse2                    -> entry `pulseRelative`
//     pulse1Absolute / pulse2Absolute    -> entry `pulseAbsolute`
//     externalTemperature / ...2         -> entry `externalTemperature`
//     digital1 / digital2                -> entry `digital` (raw 1/0)
// Note the sibling type 0x1b (EXT_ANALOG_UV, µV load-cell/UV input) is a
// distinct unpaired sensor, not port 2 of the analog bank, so `analogUv` stays
// top-level. Whole-device readings stay top-level too: battery, air.*,
// acceleration, action.motion, distance, IR/GPS/sound/occupancy/water-leak/TVOC.
// Nothing is emitted both places.
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

function u32be(b0, b1, b2, b3) {
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
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
      // ANALOG1: external port 1 analog input, 2 bytes unsigned, mV.
      portFor(0).analogMv = u16be(bytes[i + 1], bytes[i + 2]);
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
      // EXT_DIGITAL: external port 1 digital input, 1 byte, 0/1.
      portFor(0).digital = bytes[i + 1];
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
      // EXT_DIGITAL2: external port 2 digital input, 1 byte, 0/1.
      portFor(1).digital = bytes[i + 1];
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
    return { data: { make: "elsys", model: "elt-2" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elsys";
    result.data.model = "elt-2";
  }
  return result;
}
