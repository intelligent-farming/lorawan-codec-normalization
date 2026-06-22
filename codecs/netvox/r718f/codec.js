// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718F (Wireless Reed Switch Open/Close
// Detection Sensor — dry-contact / door interface), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r311a_r718f_r730f.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x1D == 29 == R718F) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`) and bytes[4] is the reed-switch
// open/close state (upstream `OnOff`).
//
// Mapping decisions:
//   bytes[3] battery   0.1 V (high bit = low battery)  -> battery (V) + lowBattery
//   bytes[4] OnOff     0 = closed, non-zero = open     -> action.contactState
//                                                          ('closed' | 'open')
//
// This is a reed-switch (contact) sensor, so the state is emitted as
// `action.contactState` (enum 'open' | 'closed') and NOT as `action.motion`
// (a known upstream copy-paste bug for door/contact sensors).
//
// Config responses (fPort 7) carry no measurement and are reported as errors;
// reportType 0x00 (device-info frame) likewise carries no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contactState(raw) {
  // Reed switch: 0 = magnet present (door closed), non-zero = open.
  return raw === 0 ? 'closed' : 'open';
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (config response, no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 5) {
    return { errors: ['expected at least 5 bytes, got ' + bytes.length] };
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

  // Byte 4: reed-switch open/close state.
  data.action = {
    contactState: contactState(bytes[4])
  };

  return { data: data };
}
