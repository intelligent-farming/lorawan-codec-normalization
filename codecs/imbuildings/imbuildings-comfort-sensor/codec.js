// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for IMBuildings Comfort Sensor (indoor temperature,
// humidity and CO2 comfort monitor with presence detection).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/imbuildings/imbuildings.js,
// attributed in NOTICE). Ported from the upstream `decodeUplink` /
// `parseComfortSensor` (COMFORT_SENSOR, payload variant 3) path; only the
// comfort-sensor product is handled here.
//
// The comfort sensor's canonical uplink carries the IMBuildings header
// (bytes[0]=0x01 type, bytes[1]=0x03 variant, total length 20). The trailing
// 10 bytes are: device_status(1), battery_voltage(2), temperature(2),
// humidity(2), CO2(2), presence(1). Battery is reported in centivolts and is
// emitted directly into the vocabulary `battery` (V) field. Temperature and
// humidity are decoded with the upstream UNSIGNED big-endian readers (no two's
// complement), faithful to the reference.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function toHexString(bytes, index, length) {
  var s = '';
  for (var i = 0; i < length; i++) {
    var b = bytes[index + i];
    if (b < 16) {
      s = s + '0';
    }
    s = s + b.toString(16);
  }
  return s;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  // Canonical comfort-sensor uplink: IMBuildings header, payload type 0x01
  // (COMFORT_SENSOR), payload variant 0x03, total length 20 bytes.
  if (bytes.length !== 20 || bytes[0] !== 0x01 || bytes[1] !== 0x03) {
    return { errors: ['unrecognized IMBuildings Comfort Sensor payload'] };
  }

  var len = bytes.length;
  var deviceId = toHexString(bytes, 2, 8);
  var deviceStatus = bytes[len - 10];
  var batteryVolts = u16be(bytes[len - 9], bytes[len - 8]) / 100;
  var temperature = u16be(bytes[len - 7], bytes[len - 6]) / 100;
  var humidity = u16be(bytes[len - 5], bytes[len - 4]) / 100;
  var co2 = u16be(bytes[len - 3], bytes[len - 2]);
  var presence = bytes[len - 1] === 1;

  var data = {
    battery: round(batteryVolts, 2),
    air: {
      location: 'indoor',
      temperature: round(temperature, 2),
      relativeHumidity: round(humidity, 2),
      co2: co2
    },
    action: {
      motion: {
        detected: presence
      }
    },
    deviceId: deviceId,
    deviceStatus: deviceStatus
  };

  return { data: data };
}
