// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for makerfabs/4-channel-adc (Makerfabs 4-Channel ADC
// 12-bit LoRaWAN node: four single-ended analog voltage inputs, plus an optional
// differential reading). Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Makerfabs decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/4-channel-adc.js, attributed
// in NOTICE). Upstream emits opaque fieldN keys; this module authors normalized
// vocabulary keys. Upstream normalization is never copied.
//
// 17-byte frame (big-endian):
//   bytes[0..1]   frame counter                       -> frameCounter (extra)
//   byte[2]       battery, decivolts (/10)            -> battery (V)
//   bytes[3..4]   ADC1, mV (/1000)                    -> analog.voltage (V)
//   bytes[5..6]   ADC2, mV (/1000)                    -> voltage2 (V extra)
//   bytes[7..8]   ADC3, mV (/1000)                    -> voltage3 (V extra)
//   bytes[9..10]  ADC4, mV (/1000)                    -> voltage4 (V extra)
//   bytes[11..12] differential input, mV (/1000)      -> differentialVoltage (V extra)
//   bytes[13..16] measurement interval, ms (/1000)    -> timeInterval (s extra)
//
// The ADC value carries a real unit (volts), so channel 1 maps to analog.voltage
// rather than analog.raw.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(b, i) {
  return ((b[i] << 8) | b[i + 1]) & 0xffff;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length !== 17) {
    return { errors: ['expected 17-byte frame, got ' + (b ? b.length : 0)] };
  }

  var data = {
    frameCounter: u16(b, 0),
    battery: round(b[2] / 10, 1),
    analog: { voltage: round(u16(b, 3) / 1000, 3) },
    voltage2: round(u16(b, 5) / 1000, 3),
    voltage3: round(u16(b, 7) / 1000, 3),
    voltage4: round(u16(b, 9) / 1000, 3),
    differentialVoltage: round(u16(b, 11) / 1000, 3),
    timeInterval: round((((b[13] << 24) | (b[14] << 16) | (b[15] << 8) | b[16]) >>> 0) / 1000, 3)
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "4-channel-adc";
  }
  return result;
}
