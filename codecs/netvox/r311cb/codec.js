// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R311CB (Wireless Window/Door Sensor and
// Wireless Glass Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r718da2_r718db2_r718f2.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// The R311CB has a built-in reed switch (door/window open-close detection) and
// can be externally connected to a broken-glass sensor. fPort 6 carries
// periodic data reports: bytes[0] is the frame version, bytes[1] the device
// type (0x56 == 86 == R311CB) and bytes[2] the report-type discriminator.
//
// reportType 0x00 is a device-info/startup frame (software / hardware version +
// datecode) and carries no measurement. For a status frame, bytes[3] is battery
// voltage in 0.1 V (high bit flags low battery, surfaced as the camelCase extra
// `lowBattery`). Upstream exposes bytes[4] as `status1` and bytes[5] as
// `status2` without interpretation; per the R311CB datasheet, status1 is the
// reed-switch (door/window) contact state and status2 is the externally
// connected glass-break sensor state, both 0 = closed / non-zero = open/alarm.
//
// Mapping decisions:
//   bytes[3] battery             0.1 V                   -> battery (volts)
//   bytes[4] reed switch state   0 = closed, != 0 = open -> action.contactState
//   bytes[5] glass sensor state  0 = intact, != 0 = broken -> glassBroken extra
//
// Config responses (fPort 7) carry no measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contactState(raw) {
  // Reed switch: 0 = magnet present (door/window closed), non-zero = open.
  return raw === 0 ? 'closed' : 'open';
}

function decodeUplinkCore(input) {
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

  // Byte 4: reed-switch (door/window) contact state.
  data.action = {
    contactState: contactState(bytes[4])
  };

  // Byte 5: externally connected broken-glass sensor state (categorical extra).
  data.glassBroken = bytes[5] === 0 ? false : true;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r311cb";
  }
  return result;
}
