// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Tektelic COMFORT Smart Room Sensor
// (T00061xx, base variant).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type "header" TLV on fPort 10) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic/t00061xx-codec.yaml ->
// decoder_smart_room_sensor.js, attributed in NOTICE).
//
// Notes / deliberate divergences from upstream normalizeUplink (which is buggy):
//   * "light_detected" (header 02 00) and "light_intensity" (header 10 02) are
//     CATEGORICAL flags/levels, not lux. Upstream forces light_detected into
//     air.lightIntensity, which is wrong (lightIntensity is lux). We emit them
//     as the camelCase extras `lightDetected` (boolean) and `lightLevel`
//     (raw level) and do NOT claim air.lightIntensity.
//   * Battery is reported in VOLTS by this device (headers 00 FF and 00 BA),
//     so it maps to the vocabulary `battery` (V) directly.
//   * reed_state (header 01 00) semantics (which value means open vs closed)
//     are not pinned down by the upstream reference or an example here, so we
//     emit the raw value as the extra `reedState` rather than guessing the
//     action.contactState enum.

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
  var fPort = input.fPort;

  if (fPort !== 10) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 10)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xff) {
      // battery voltage, signed 16-bit, 0.01 V
      data.battery = round(s16be(bytes[i + 2], bytes[i + 3]) * 0.01, 2);
      i += 4;
      recognized = true;
    } else if (channel === 0x00 && type === 0xba) {
      // battery voltage, unsigned 16-bit (mV), 0.001 V
      data.battery = round(u16be(bytes[i + 2], bytes[i + 3]) * 0.001, 3);
      i += 4;
      recognized = true;
    } else if (channel === 0x01 && type === 0x00) {
      // reed switch state (raw; enum semantics unverified)
      data.reedState = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x02 && type === 0x00) {
      // light detected flag (categorical, not lux)
      data.lightDetected = bytes[i + 2] > 0;
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // ambient temperature, signed 16-bit, 0.1 C
      air.temperature = round(s16be(bytes[i + 2], bytes[i + 3]) * 0.1, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // relative humidity, unsigned 8-bit, 0.5 %
      air.relativeHumidity = round(bytes[i + 2] * 0.5, 1);
      i += 3;
      recognized = true;
    } else if (channel === 0x0a && type === 0x00) {
      // PIR motion event state (>0 means motion detected)
      motion.detected = bytes[i + 2] > 0;
      i += 3;
      recognized = true;
    } else if (channel === 0x0b && type === 0x67) {
      // MCU temperature, signed 16-bit, 0.1 C (diagnostic, not ambient)
      data.mcuTemperature = round(s16be(bytes[i + 2], bytes[i + 3]) * 0.1, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x0d && type === 0x04) {
      // PIR motion event count, unsigned 16-bit
      motion.count = u16be(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    } else if (channel === 0x10 && type === 0x02) {
      // light intensity level (categorical level, not lux)
      data.lightLevel = bytes[i + 2];
      i += 3;
      recognized = true;
    } else {
      return {
        errors: ['unknown channel/type 0x' + channel.toString(16) + ' 0x' + type.toString(16)]
      };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Tektelic channels'] };
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }
  if (motion.detected !== undefined || motion.count !== undefined) {
    data.action = { motion: motion };
  }

  return { data: data };
}
