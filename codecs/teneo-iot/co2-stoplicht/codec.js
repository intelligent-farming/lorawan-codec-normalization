// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Teneo IoT CO2 Stoplicht (CO2 traffic-light:
// indoor CO2 + temperature + humidity monitor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/teneo-iot/co2-stoplicht.js,
// attributed in NOTICE). Ported from that decoder; do NOT copy upstream
// normalizeUplink as our output.
//
// Wire format:
//   byte 0       : low nibble (0x0f) = battery, volts = nibble/10 + 2 (2.0-3.5V)
//                  on fPort 223, high bits 0xc0 == 0x80 flag a status frame and
//                  the low 6 bits (& ~0xc0) carry the traffic-light state.
//   fPort 1 (measurement):
//   byte 1       : RFU
//   bytes 2..5   : CO2, big-endian int32, ppm = value / 100
//   bytes 6..7   : temperature x100, big-endian; 0x7fff (32767) = no reading,
//                  values > 32767 are two's-complement negatives.
//   bytes 8..9   : relative humidity, big-endian, % = value / 100
//
// This device reports battery as VOLTS, so it maps to the vocabulary `battery`
// (not `batteryPercent`). The traffic-light status frame and message type are
// device-specific and emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  data.battery = round((bytes[0] & 0x0f) / 10 + 2, 1);

  if (input.fPort === 223) {
    if ((bytes[0] & 0xc0) === 0x80) {
      data.messageType = 'status';
      data.trafficLightState = bytes[0] & ~0xc0;
    }
    return { data: data };
  }

  if (input.fPort === 1) {
    if (bytes.length < 10) {
      return { errors: ['measurement frame too short on fPort 1'] };
    }

    var air = { location: 'indoor' };

    air.co2 = round(
      ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) / 100,
      2
    );

    var tempX100 = (bytes[6] << 8) + bytes[7];
    if (tempX100 === 32767) {
      // 0x7fff sentinel: temperature reading unavailable.
      air.temperatureValid = false;
    } else {
      if (tempX100 > 32767) {
        tempX100 = tempX100 - 65536;
      }
      air.temperature = round(tempX100 / 100, 2);
    }

    air.relativeHumidity = round(((bytes[8] << 8) | bytes[9]) / 100, 2);

    data.air = air;
    return { data: data };
  }

  // Any other fPort carries only the battery nibble (matches upstream, which
  // always decodes battery and returns the rest empty).
  return { data: data };
}
