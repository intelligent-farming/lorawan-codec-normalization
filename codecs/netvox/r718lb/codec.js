// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R718LB (Wireless Hall Type Open/Close
// Detector), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/r718da_r718db_r718j_r718lb_r718mba.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x25 == 37 == R718LB) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// (status) frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`) and bytes[4] is the
// Hall open/close status -> action.contactState.
//
// Mapping decisions (this device has NO temperature/humidity/leak channel in
// the upstream decoder — it reports battery + an open/close status byte only):
//   bytes[3] battery        0.1 V (bit7 = low-battery flag) -> battery (V)
//                                                            -> lowBattery extra
//   bytes[4] Hall status    0 = closed, 1 = open            -> action.contactState
//
// The status byte is a contact (Hall/reed) open/close state, so it is emitted
// as `action.contactState` ('open' | 'closed') and NOT as `action.motion`
// (a known upstream copy-paste bug for open/close sensors). Config responses
// (fPort 7) and the device-info frame (reportType 0x00) carry no measurement
// and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contactState(raw) {
  // Hall open/close status: 0 = magnet present (closed), 1 = open.
  return raw === 0 ? 'closed' : 'open';
}

function decodeUplink(input) {
  var bytes = input.bytes;

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

  // Byte 4: Hall open/close status -> action.contactState.
  data.action = {
    contactState: contactState(bytes[4])
  };

  return { data: data };
}
