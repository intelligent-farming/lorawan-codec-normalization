// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for mclimate/t-valve (MClimate T-Valve — LoRaWAN
// water shut-off valve with integrated flood/leak detection and temperature).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/t-valve.js, attributed in
// NOTICE). The wire format is reproduced faithfully; the normalized output is
// authored here and maps the device's flood detection to water.leak.
//
// Wire format (big-endian bit strings, MSB = bit index 0):
//   Short package (2 bytes, periodic keepalive — no leak state):
//     byte0          = water temperature, raw / 2 (°C)
//     byte1 bit0     = valve state (1 = open)
//     byte1 bits1..7 = ambient temperature, (raw - 20) / 2 (°C)
//   Long package (>=5 bytes, event/status):
//     byte0 bits0..2 = message reason (keepalive | testButtonPressed |
//                      floodDetected | controlButtonPressed | fraudDetected)
//     byte0 bit4     = box tamper
//     byte0 bit5     = flood detection wire state
//     byte0 bit6     = flood (leak detected)
//     byte0 bit7     = magnet
//     byte1 bit0     = alarm validated
//     byte1 bit1     = manual open indicator
//     byte1 bit2     = manual close indicator
//     byte2          = close time (s)
//     byte3          = open time (s)
//     byte4          = battery, (raw * 8 + 1600) / 1000 (V)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || typeof bytes.length !== 'number') {
    return { errors: ['no bytes'] };
  }

  var i;
  for (i = 0; i < bytes.length; i++) {
    if (typeof bytes[i] !== 'number' || bytes[i] < 0 || bytes[i] > 255) {
      return { errors: ['invalid byte at index ' + i] };
    }
  }

  // Build 8-char binary strings (MSB first), matching the upstream layout.
  var byteArray = [];
  for (i = 0; i < bytes.length; i++) {
    var bin = bytes[i].toString(2);
    while (bin.length < 8) {
      bin = '0' + bin;
    }
    byteArray.push(bin);
  }

  var toBool = function (chr) {
    return chr === '1';
  };

  if (byteArray.length === 2) {
    // Short periodic uplink: temperature + valve state only (no leak state).
    var waterTemp = parseInt(byteArray[0], 2) / 2;
    var ambientTemp = (parseInt(byteArray[1].slice(1, 8), 2) - 20) / 2;
    return {
      data: {
        water: {
          temperature: {
            current: round(waterTemp, 1)
          }
        },
        air: {
          temperature: round(ambientTemp, 1)
        },
        reason: 'keepalive',
        valveOpen: toBool(byteArray[1][0])
      }
    };
  }

  if (byteArray.length > 2) {
    if (byteArray.length < 5) {
      return { errors: ['long package too short'] };
    }
    var messageTypes = [
      'keepalive',
      'testButtonPressed',
      'floodDetected',
      'controlButtonPressed',
      'fraudDetected'
    ];
    var reasonIdx = parseInt(byteArray[0].slice(0, 3), 2);
    var battery = (parseInt(byteArray[4], 2) * 8 + 1600) / 1000;
    return {
      data: {
        water: {
          leak: toBool(byteArray[0][6])
        },
        battery: round(battery, 3),
        reason: messageTypes[reasonIdx],
        boxTamper: toBool(byteArray[0][4]),
        floodDetectionWireState: toBool(byteArray[0][5]),
        magnet: toBool(byteArray[0][7]),
        alarmValidated: toBool(byteArray[1][0]),
        manualOpenIndicator: toBool(byteArray[1][1]),
        manualCloseIndicator: toBool(byteArray[1][2]),
        closeTime: parseInt(byteArray[2], 2),
        openTime: parseInt(byteArray[3], 2)
      }
    };
  }

  return { errors: ['unrecognized payload length'] };
}
