// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM500-LGT (Light Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em500-lgt.js, attributed in NOTICE).
//
// Illuminance (channel 0x03/0x94) is a uint32 of lux -> air.lightIntensity.
// Battery is a percentage (-> batteryPercent extra; vocabulary `battery` is
// volts).

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var data = {};
  var air = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x94) {
      air.lightIntensity = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      i += 6;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }
  if (air.lightIntensity !== undefined) {
    data.air = air;
  }
  return { data: data };
}
