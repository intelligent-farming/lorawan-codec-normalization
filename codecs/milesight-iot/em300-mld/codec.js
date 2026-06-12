// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM300-MLD (Leak Detection Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em300-mld.js, attributed in NOTICE).
//
// The datalog channel (0x20/0xce) carries timestamped prior readings; those map
// to the vocabulary `history` array (current reading stays at the top level).
// Battery is a percentage (-> batteryPercent extra; vocabulary `battery` is
// volts).

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var data = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x00) {
      data.water = { leak: bytes[i + 2] !== 0 };
      i += 3;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      var epoch = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      var point = { water: { leak: bytes[i + 9] !== 0 } };
      if (epoch > 0) {
        point.time = new Date(epoch * 1000).toISOString();
      }
      if (!data.history) {
        data.history = [];
      }
      data.history.push(point);
      i += 10;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }
  return { data: data };
}
