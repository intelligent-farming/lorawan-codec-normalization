// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718IA2 (Wireless 2-Input 0-5V ADC
// Sampling Interface). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718ia2_ib2.js,
// shared by the R718IA2 (device id 0x41, 0-5 V) and R718IB2 (device id 0x42,
// 0-10 V) and attributed in NOTICE). Author the normalization here; do NOT
// copy upstream decodeUplink.
//
// The R718IA2 samples two 0-5 V analog inputs. Each raw ADC field is expressed
// in millivolts, so we normalize to volts (mV / 1000). Channel 1 maps to the
// analog-interface vocabulary key `analog.voltage`; channel 2 is the camelCase
// extra `voltage2` (the vocabulary models a single analog input per device).
//
// fPort 6 frame layout (device id byte[1] == 0x41 for R718IA2):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x41 == R718IA2)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4..5]   channel-1 ADC in mV, 16-bit big-endian -> analog.voltage (V)
//   bytes[6..7]   channel-2 ADC in mV, 16-bit big-endian -> extra voltage2 (V)
//   bytes[8..10]  unused
//
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (configuration response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['expected at least 8 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x41) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x41, R718IA2)'] };
  }
  if (bytes[2] === 0x00) {
    return { errors: ['device information frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Bytes 4..5: channel-1 ADC (mV) -> analog.voltage (V).
  var analog = {};
  analog.voltage = round(((bytes[4] << 8) | bytes[5]) / 1000, 3);
  data.analog = analog;

  // Bytes 6..7: channel-2 ADC (mV) -> extra voltage2 (V).
  data.voltage2 = round(((bytes[6] << 8) | bytes[7]) / 1000, 3);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718ia2";
  }
  return result;
}
