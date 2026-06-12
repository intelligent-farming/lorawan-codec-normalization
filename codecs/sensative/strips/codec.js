// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Sensative Strips (Comfort / Drips / Guard)
// multi-sensor LoRaWAN devices (temperature, humidity, ambient light, door /
// reed, motion / presence, flood, etc.).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Sensative channel/length framed reports) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/sensative/strips.js, attributed in NOTICE). Do NOT copy upstream
// normalizeUplink; the normalization below is authored here.
//
// Frame format (fPort 1, "current" report): the first two bytes are a
// big-endian history sequence number, followed by one or more frames. Each
// frame begins with a `type` byte whose low 7 bits select a channel and whose
// high bit (0x80) marks a "history" frame; the channel determines how many
// payload bytes follow. fPort 2 ("history" report) encodes each prior reading
// relative to the gateway clock (a 4-byte "seconds ago" delta), which cannot be
// resolved to a deterministic RFC3339 timestamp inside a stateless codec, so it
// is reported as an unsupported port rather than emitting a guessed time.
//
// Battery is reported by the device as a PERCENTAGE (0-100%); the vocabulary's
// `battery` is volts, so the percentage is emitted as the camelCase extra
// `batteryPercent`. Door channel 9 documents false = open, true = closed.

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

function decodeFrame(bytes, pos, data, air, action, flags) {
  var channel = bytes[pos] & 0x7f;
  pos++;

  if (channel === 0) {
    // empty frame, no payload
    return pos;
  }
  if (channel === 1) {
    // Battery 1 byte, 0-100%
    data.batteryPercent = bytes[pos];
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 2) {
    // Temperature 2 bytes, signed, 0.1 degree C
    air.temperature = round(s16be(bytes[pos], bytes[pos + 1]) / 10, 1);
    flags.recognized = true;
    return pos + 2;
  }
  if (channel === 3) {
    // Temp alarm (high/low) 1 byte
    data.temperatureAlarm = {
      high: (bytes[pos] & 0x01) !== 0,
      low: (bytes[pos] & 0x02) !== 0
    };
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 4) {
    // Average temperature 2 bytes, signed, 0.1 degree C
    data.averageTemperature = round(s16be(bytes[pos], bytes[pos + 1]) / 10, 1);
    flags.recognized = true;
    return pos + 2;
  }
  if (channel === 5) {
    // Average temp alarm 1 byte
    data.averageTemperatureAlarm = {
      high: (bytes[pos] & 0x01) !== 0,
      low: (bytes[pos] & 0x02) !== 0
    };
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 6) {
    // Humidity 1 byte, 0.5% steps
    air.relativeHumidity = round(bytes[pos] / 2, 1);
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 7) {
    // Lux 2 bytes, 0-65535 lux
    air.lightIntensity = u16be(bytes[pos], bytes[pos + 1]);
    flags.recognized = true;
    return pos + 2;
  }
  if (channel === 8) {
    // Lux (second range) 2 bytes, 0-65535 lux
    air.lightIntensity = u16be(bytes[pos], bytes[pos + 1]);
    flags.recognized = true;
    return pos + 2;
  }
  if (channel === 9) {
    // Door / reed switch 1 byte: false = open, true = closed
    action.contactState = bytes[pos] !== 0 ? 'closed' : 'open';
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 10) {
    // Door alarm 1 byte
    data.doorAlarm = bytes[pos] !== 0;
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 11) {
    // Tamper report 1 byte
    data.tamper = bytes[pos] !== 0;
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 12) {
    // Tamper alarm 1 byte
    data.tamperAlarm = bytes[pos] !== 0;
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 13) {
    // Flood 1 byte, relative wetness 0-100%
    data.floodPercent = bytes[pos];
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 14) {
    // Flood alarm 1 byte (boolean leak state)
    data.water = { leak: bytes[pos] !== 0 };
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 15) {
    // Oil/foil alarm 1 byte
    data.oilAlarm = bytes[pos] !== 0;
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 16) {
    // User switch 1 alarm 1 byte
    data.userSwitch1Alarm = bytes[pos] !== 0;
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 17) {
    // Door count 2 bytes
    action.motion = { count: u16be(bytes[pos], bytes[pos + 1]) };
    flags.recognized = true;
    return pos + 2;
  }
  if (channel === 18) {
    // Presence / PIR 1 byte (boolean)
    if (!action.motion) {
      action.motion = {};
    }
    action.motion.detected = bytes[pos] !== 0;
    flags.recognized = true;
    return pos + 1;
  }
  if (channel === 19) {
    // IR proximity 2 bytes
    data.irProximity = u16be(bytes[pos], bytes[pos + 1]);
    flags.recognized = true;
    return pos + 2;
  }
  if (channel === 20) {
    // IR close proximity 2 bytes
    data.irCloseProximity = u16be(bytes[pos], bytes[pos + 1]);
    flags.recognized = true;
    return pos + 2;
  }
  if (channel === 21) {
    // Close proximity alarm 1 byte
    data.closeProximityAlarm = bytes[pos] !== 0;
    flags.recognized = true;
    return pos + 1;
  }

  // Unknown channel: cannot know its length, so stop framing here.
  flags.unknown = true;
  return -1;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  if (fPort !== 1) {
    // fPort 2 carries clock-relative history that cannot be resolved to a
    // deterministic timestamp here; any other port is undefined.
    return { errors: ['unsupported fPort: ' + fPort] };
  }
  if (bytes.length < 2) {
    return { errors: ['payload too short for Sensative current report'] };
  }

  var data = {};
  var air = {};
  var action = {};
  var flags = { recognized: false, unknown: false };

  var pos = 2; // skip 2-byte history sequence number
  while (pos < bytes.length) {
    pos = decodeFrame(bytes, pos, data, air, action, flags);
    if (pos < 0) {
      break;
    }
  }

  if (flags.unknown && !flags.recognized) {
    return { errors: ['no recognized Sensative channels'] };
  }
  if (!flags.recognized) {
    return { errors: ['no recognized Sensative channels'] };
  }

  var hasAir = false;
  var k;
  for (k in air) {
    if (Object.prototype.hasOwnProperty.call(air, k)) {
      hasAir = true;
    }
  }
  if (hasAir) {
    data.air = air;
  }

  var hasAction = false;
  for (k in action) {
    if (Object.prototype.hasOwnProperty.call(action, k)) {
      hasAction = true;
    }
  }
  if (hasAction) {
    data.action = action;
  }

  return { data: data };
}
