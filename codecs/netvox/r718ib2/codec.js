// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718IB2 (Wireless 2-Input 0-10V ADC
// Sampling Interface). Data reports arrive on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718ia2_ib2.js,
// shared by the R718IA2 (device id 0x41, 0-5 V) and R718IB2 (device id 0x42,
// 0-10 V) and attributed in NOTICE). Author the normalization here; do NOT
// copy upstream decodeUplink.
//
// The R718IB2 samples two 0-10 V analog inputs. Each raw ADC field is expressed
// in millivolts, so we normalize to volts (mV / 1000, rounded to 3 decimals —
// the sensor's own 1 mV resolution).
//
// Netvox calls the two terminals "inputs" (the datasheet name is "2-Input
// 0-10V ADC Sampling Interface"). They are sub-sensor positions of one device
// carrying the same quantity, so their readings ride in the reserved `channels`
// array (see AUTHORING.md "Multi-channel devices") rather than in a suffixed
// `voltage2` extra: one entry per input, labelled with the vendor's own term
// plus a zero-based index — `input0` (Netvox channel 1, bytes[4..5]) and
// `input1` (Netvox channel 2, bytes[6..7]) — each carrying the `analog.voltage`
// vocabulary key in V. `battery` and the `lowBattery` flag are whole-device
// readings and stay top-level; no leaf is emitted in both places.
//
// Sentinel policy: this frame format defines NO disconnected-input sentinel.
// Neither the shared upstream decoder nor the report layout reserves a "no
// probe" value — both ADC words are plain unsigned millivolt readings across
// the input's full range — so no value is treated as a sentinel and neither
// input entry is ever suppressed on its reading. Nor can a short frame
// fabricate one: the length guard below requires all 8 header+measurement
// bytes, so both input words are always present when a frame decodes.
//
// fPort 6 frame layout (device id byte[1] == 0x42 for R718IB2):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x42 == R718IB2)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4..5]   channel-1 ADC in mV, 16-bit big-endian -> channels[] `input0`
//   bytes[6..7]   channel-2 ADC in mV, 16-bit big-endian -> channels[] `input1`
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
  if (bytes[1] !== 0x42) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x42, R718IB2)'] };
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

  // One channels[] entry per input terminal: bytes 4..5 = Netvox channel 1
  // (`input0`), bytes 6..7 = Netvox channel 2 (`input1`); both ADC (mV) -> V.
  data.channels = [
    { channel: 'input0', analog: { voltage: round(((bytes[4] << 8) | bytes[5]) / 1000, 3) } },
    { channel: 'input1', analog: { voltage: round(((bytes[6] << 8) | bytes[7]) / 1000, 3) } }
  ];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r718ib2" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718ib2";
  }
  return result;
}
