// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Arwin Technology LRS20100 (Temperature &
// Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Ported
// from the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/arwin-technology/lrs20100.js, attributed in NOTICE), which is the
// source of truth for the wire format:
//   - fPort 10, bytes[0]===1: sensor data (event bitmask, battery %, temp, RH)
//   - fPort 8: firmware version string
//   - fPort 12, bytes[0]===1: device settings (data upload interval)
//   - fPort 13, bytes[0]===1: threshold settings
// temperature and humidity are signed 16-bit, big-endian, scaled by 1/10.
//
// The LRS20100 reports battery as a PERCENTAGE; the vocabulary's `battery` is
// volts, so the percentage is emitted as the camelCase extra `batteryPercent`
// rather than being forced into a volts field. The event bitmask and the
// version/settings/threshold fields have no vocabulary mapping and are emitted
// as camelCase extras.

var LRS20100_EVENTS = [
  'heartbeat',
  'rsvd',
  'temperature_high',
  'temperature_low',
  'humidity_high',
  'humidity_low'
];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16be(hi, lo) {
  var dec = ((hi << 8) | lo) & 0xffff;
  if (dec & 0x8000) {
    dec = dec - 0x10000;
  }
  return dec;
}

function decodeEvent(flags) {
  var evt = '';
  for (var i = 0; i < 8; i++) {
    if ((0x01 << i) & flags) {
      var name = LRS20100_EVENTS[i];
      if (name === undefined) {
        continue;
      }
      if (evt === '') {
        evt = name;
      } else {
        evt = evt + ',' + name;
      }
    }
  }
  return evt;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort === 10) {
    // sensor data
    if (bytes[0] === 1) {
      var data = {};
      data.event = decodeEvent(bytes[1]);
      data.batteryPercent = bytes[2];
      data.air = {
        temperature: round(s16be(bytes[3], bytes[4]) / 10, 1),
        relativeHumidity: round(s16be(bytes[5], bytes[6]) / 10, 1)
      };
      return { data: data };
    }
    return { errors: ['unknown sensor type'] };
  }

  if (input.fPort === 8) {
    // version
    var ver =
      bytes[0] +
      '.' +
      ('00' + bytes[1]).slice(-2) +
      '.' +
      ('000' + ((bytes[2] << 8) | bytes[3])).slice(-3);
    return { data: { firmwareVersion: ver } };
  }

  if (input.fPort === 12) {
    // device settings
    if (bytes[0] === 1) {
      return { data: { dataUploadInterval: s16be(bytes[1], bytes[2]) } };
    }
    return { errors: ['unknown sensor type'] };
  }

  if (input.fPort === 13) {
    // threshold settings
    if (bytes[0] === 1) {
      return {
        data: {
          highTemperatureThreshold: s16be(bytes[1], bytes[2]),
          lowTemperatureThreshold: s16be(bytes[3], bytes[4]),
          highHumidityThreshold: bytes[5],
          lowHumidityThreshold: bytes[6]
        }
      };
    }
    return { errors: ['unknown sensor type'] };
  }

  return { errors: ['unknown FPort'] };
}
