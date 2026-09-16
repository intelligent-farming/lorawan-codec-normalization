// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Netvox R718IJK (Wireless Multi-Sensor
// Interface for 0-24V ADC, Dry Contact and 4-20mA Sensors). Data reports arrive
// on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718ijk.js, device id
// 0x5C, attributed in NOTICE). Author the normalization here; do NOT copy
// upstream decodeUplink.
//
// The R718IJK combines three interfaces in one frame. Two of them map directly
// onto analog-interface vocabulary keys and are surfaced as normalized keys:
//   - the 4-20 mA loop current -> `analog.current` (mA)
//   - the dry-contact state    -> `action.contactState` ("open" | "closed")
// The 0-24 V ADC channel has no dedicated slot alongside analog.current (the
// vocabulary models a single analog input), so it is surfaced as the camelCase
// extra `adcVoltage` (V, from the raw mV field).
//
// fPort 6 frame layout (device id byte[1] == 0x5C for R718IJK):
//   bytes[0]      frame/software version marker
//   bytes[1]      device type id (0x5C == R718IJK)
//   bytes[2]      report type; 0x00 is a device-info frame (no measurement)
//   bytes[3]      battery voltage in 0.1 V; high bit (0x80) flags low battery,
//                 surfaced as the camelCase extra `lowBattery`
//   bytes[4]      dry-contact state (0 = open, non-zero = closed)
//                 -> action.contactState
//   bytes[5]      4-20 mA loop current, integer milliamps
//   bytes[6..7]   0-24 V ADC reading in millivolts, 16-bit big-endian
//                 -> extra adcVoltage (V; mV / 1000)
//   bytes[8]      4-20 mA loop current, fractional part in 0.1 mA
//                 (analog.current = bytes[5] + bytes[8] / 10, mA)
//   bytes[9..10]  unused
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
  if (!bytes || bytes.length < 9) {
    return { errors: ['expected at least 9 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if (bytes[1] !== 0x5C) {
    return { errors: ['unexpected device id 0x' + bytes[1].toString(16) + ' (expected 0x5c, R718IJK)'] };
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

  // Byte 4: dry-contact state -> action.contactState.
  var action = {};
  action.contactState = bytes[4] !== 0x00 ? 'closed' : 'open';
  data.action = action;

  // Byte 5 (integer mA) + byte 8 (0.1 mA) -> analog.current (mA).
  var analog = {};
  analog.current = round(bytes[5] + bytes[8] / 10, 1);
  data.analog = analog;

  // Bytes 6..7: 0-24 V ADC reading in mV -> extra adcVoltage (V).
  data.adcVoltage = round(((bytes[6] << 8) | bytes[7]) / 1000, 3);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r718ijk" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718ijk";
  }
  return result;
}
