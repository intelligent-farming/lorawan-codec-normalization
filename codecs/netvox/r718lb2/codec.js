// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718LB2 (Wireless 2-Gang Hall Type
// Open/Close Detection Sensor), data report on fPort 6.
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/
// r718da2_r718db2_r718f2.js, attributed in NOTICE). The upstream decodeUplink
// is the source of truth for the wire format; the normalization here is
// authored to the shared vocabulary and does NOT copy upstream's
// Volt/status1/status2 output.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x45 == 69 == R718LB2) and bytes[2] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement. For a
// measurement frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`), bytes[4] is the
// channel-1 Hall switch state and bytes[5] the channel-2 Hall switch state
// (0 = closed, non-zero = open).
//
// This is a 2-channel (2-gang) contact sensor but `action.contactState` is a
// single-valued enum, so channel 1 maps to `action.contactState` and channel 2
// to the camelCase extra `contactState2` (same "open"/"closed" vocabulary).
// The Hall switch is a contact sensor, so the state is emitted as
// action.contactState and NOT action.motion (a known upstream copy-paste bug
// for door sensors).
//
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contactState(raw) {
  // Netvox Hall switch: 0 = closed, non-zero = open.
  return raw === 0 ? 'closed' : 'open';
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // Byte 4: channel-1 Hall switch state -> action.contactState.
  // Byte 5: channel-2 Hall switch state -> extra contactState2.
  data.action = {
    contactState: contactState(bytes[4])
  };
  data.contactState2 = contactState(bytes[5]);

  return { data: data };
}
