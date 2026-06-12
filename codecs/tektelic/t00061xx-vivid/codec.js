// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Tektelic VIVID Smart Room Sensor PIR
// (t00061xx, "T00061xx"). Decodes application uplinks on fPort 10.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV: a 2-byte [channel, type] header followed
// by big-endian data bytes) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/tektelic/decoder_smart_room_sensor.js, attributed in NOTICE). The
// upstream normalizeUplink is NOT copied: it (1) maps the categorical
// `light_detected` flag (0/1) into air.lightIntensity (a lux field) and
// (2) writes the raw numeric reed_state into action.contactState (an
// open/closed enum). Both are corrected here.
//
// Decisions:
//   * Tektelic multi-byte fields are BIG-endian (MSB first), unlike Milesight.
//   * `light_detected` (channel 0x02 0x00) is a categorical detect flag, not a
//     lux reading, so it is emitted as the extra `lightDetected` (0/1). The
//     true lux channel is `light_intensity` (0x10 0x02) -> air.lightIntensity.
//   * `reed_state` (0x01 0x00) maps to the action.contactState enum: the reed
//     contact is closed when the magnet is present (state 0) and open when it
//     is removed (state non-zero).
//   * battery (channel 0x00 0xBA, mV/1000; or 0x00 0xFF, cV/100) is volts, so
//     it goes in the vocabulary `battery` field directly.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 10) {
    return { errors: ['unsupported fPort ' + port + ' (expected 10)'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var action = {};
  var motion = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xba) {
      // battery voltage, 2-byte unsigned, mV
      data.battery = round(u16be(bytes[i + 2], bytes[i + 3]) / 1000, 3);
      i += 4;
      recognized = true;
    } else if (channel === 0x00 && type === 0xff) {
      // battery voltage, 2-byte signed, cV
      data.battery = round(s16be(bytes[i + 2], bytes[i + 3]) / 100, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x01 && type === 0x00) {
      // reed switch state -> contact enum (0 = magnet present = closed)
      action.contactState = bytes[i + 2] !== 0 ? 'open' : 'closed';
      i += 3;
      recognized = true;
    } else if (channel === 0x02 && type === 0x00) {
      // light DETECTED flag (categorical 0/1), not a lux reading
      data.lightDetected = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // ambient temperature, 2-byte signed, 0.1 C
      air.temperature = round(s16be(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // relative humidity, 1-byte unsigned, 0.5 %
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      i += 3;
      recognized = true;
    } else if (channel === 0x09 && type === 0x00) {
      // moisture, 1-byte unsigned (vendor units; no vocabulary key)
      data.moisture = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x0a && type === 0x00) {
      // PIR motion event state -> motion detected
      motion.detected = bytes[i + 2] !== 0;
      i += 3;
      recognized = true;
    } else if (channel === 0x0b && type === 0x67) {
      // MCU (internal) temperature, 2-byte signed, 0.1 C (diagnostic extra)
      data.mcuTemperature = round(s16be(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x0d && type === 0x04) {
      // PIR motion event count, 2-byte unsigned
      motion.count = u16be(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x10 && type === 0x02) {
      // ambient light intensity, 1-byte unsigned, lux
      air.lightIntensity = bytes[i + 2];
      i += 3;
      recognized = true;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' +
            channel.toString(16) +
            ' 0x' +
            type.toString(16)
        ]
      };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Tektelic channels'] };
  }

  if (motion.detected !== undefined || motion.count !== undefined) {
    action.motion = motion;
  }
  if (air.temperature !== undefined ||
      air.relativeHumidity !== undefined ||
      air.lightIntensity !== undefined) {
    data.air = air;
  }
  if (action.motion !== undefined || action.contactState !== undefined) {
    data.action = action;
  }

  return { data: data };
}
