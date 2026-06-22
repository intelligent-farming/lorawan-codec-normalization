// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311CC (Wireless 2-Gang Window/Door
// Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da2_r718db2_r718f2.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Frame layout (Netvox common format): byte0 = protocol version, byte1 =
// device type (0x6C = 108 = R311CC), byte2 = report type. fPort 6 carries data
// reports; fPort 7 carries configuration command responses (no measurement).
//
// fPort 6 report types:
//   0x00  device-info / version frame (SW/HW version, datecode) -> no
//         measurement, reported as an error.
//   else  status report: byte3 = battery voltage in 0.1 V (high bit = low
//         battery flag); byte4 = gang 1 contact status; byte5 = gang 2 contact
//         status. Each status byte is 0 = closed (magnet present), 1 = open.
//
// Mapping decisions:
//   battery        byte3 & 0x7f, /10 (V)          -> battery (volts)
//   low-battery    byte3 & 0x80                   -> lowBattery extra (bool)
//   gang 1 status  byte4 (0=closed,1=open)        -> action.contactState
//   gang 2 status  byte5 (0=closed,1=open)        -> contact2State extra
//
// The R311CC is a two-gang reed-switch contact sensor, but the vocabulary's
// action.contactState is a single enum ('open' | 'closed'). Gang 1 is mapped to
// action.contactState (the category-defining key); gang 2 is surfaced as the
// camelCase extra `contact2State` so no reading is lost. This is a contact
// sensor, so the state is emitted as action.contactState and NOT as
// action.motion (a known upstream copy-paste bug for door sensors). Upstream
// leaves the status bytes as raw integers (status1/status2) and never
// interprets them as open/closed; we author the correct mapping here.

function contactState(raw) {
  // Netvox reed switch: 0 = magnet present (closed), 1 = open.
  return raw === 1 ? 'open' : 'closed';
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['fPort 7 carries a configuration response (no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (!bytes || bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + (bytes ? bytes.length : 0)] };
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
  data.battery = (bytes[3] & 0x7f) / 10;

  // Bytes 4 and 5: per-gang reed-switch contact status.
  data.action = { contactState: contactState(bytes[4]) };
  data.contact2State = contactState(bytes[5]);

  return { data: data };
}
