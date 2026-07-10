// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for enless-wireless/tx-pulse-led-600-038
// (EN310, "TX PULSE LED 600-038" — optical/LED pulse metering transmitter).
//
// Derivation: wire format understood from the upstream Apache-2.0 multi-device
// dispatcher (TheThingsNetwork/lorawan-devices vendor/enless-wireless/
// enlessdecoder.js, attributed in NOTICE). Normalization authored here; the
// upstream flat "values/states/alarm_status" template is NOT copied. EN310
// shares the EN308 pulse frame layout, differing only in the device-type byte.
//
// Wire format (shared 6-byte Enless header):
//   bytes[0..2]    device id (24-bit)
//   bytes[3]       device type byte (EN310 = 0x0A)
//   bytes[4]       sequence counter
//   bytes[5]       firmware version
// EN310 pulse payload (all counters are cumulative, big-endian uint32):
//   bytes[6..9]    channel 1 pulse counter
//   bytes[10..13]  channel 2 pulse counter
//   bytes[14..17]  open-collector (OC) pulse counter
//   bytes[18..19]  alarm-status word (not telemetry)
//   bytes[20..21]  state word: bits 2..3 = battery level code
//                  (0=100%,1=75%,2=50%,3=25%)
// Channel 1 (cumulative) maps to the vocabulary pulse.total; the other channels
// are camelCase extras. Battery is a coarse 2-bit percentage, not a voltage, so
// it is emitted as `batteryPercent` (the vocabulary `battery` key is volts).

var DEVICE_TYPE = 0x0a;

function uint32(bytes, o) {
  return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
}

function batteryPercentFromState(hi, lo) {
  var code = (((hi << 8) | lo) >> 2) & 0x03;
  return [100, 75, 50, 25][code];
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (bytes.length !== 22) {
    return { errors: ['expected 22-byte EN310 pulse frame, got ' + bytes.length] };
  }
  if (bytes[3] !== DEVICE_TYPE) {
    return { errors: ['unexpected device type 0x' + bytes[3].toString(16) + ' (expected 0x0a EN310)'] };
  }

  var data = {};
  data.pulse = { total: uint32(bytes, 6) };
  data.channel2Total = uint32(bytes, 10);
  data.ocTotal = uint32(bytes, 14);
  data.batteryPercent = batteryPercentFromState(bytes[20], bytes[21]);
  data.deviceId = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  data.sequenceCounter = bytes[4];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enless-wireless";
    result.data.model = "tx-pulse-led-600-038";
  }
  return result;
}
