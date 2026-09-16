// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for enless-wireless/tx-analog-600-035
// (EN307, "TX 4/20 mA 600-035" — 4-20 mA analog current-loop transmitter).
//
// Derivation: wire format understood from the upstream Apache-2.0 multi-device
// dispatcher (TheThingsNetwork/lorawan-devices vendor/enless-wireless/
// enlessdecoder.js, attributed in NOTICE). Normalization authored here; the
// upstream flat "values/states/alarm_status" template is NOT copied.
//
// Wire format (shared 6-byte Enless header):
//   bytes[0..2]   device id (24-bit)
//   bytes[3]      device type byte (EN307 = 0x0D)
//   bytes[4]      sequence counter
//   bytes[5]      firmware version
// EN307 payload:
//   bytes[6..7]   loop current, big-endian signed-16, units of µA -> ÷1000 = mA
//   bytes[8..9]   alarm-status word (not telemetry)
//   bytes[10..11] state word: bits 2..3 = battery level code
//                 (0=100%,1=75%,2=50%,3=25%)
// Battery is a coarse 2-bit percentage, not a voltage, so it is emitted as the
// camelCase extra `batteryPercent` (the vocabulary `battery` key is volts).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  var v = (hi << 8) | lo;
  if (v & 0x8000) {
    v -= 0x10000;
  }
  return v;
}

function batteryPercentFromState(hi, lo) {
  var code = (((hi << 8) | lo) >> 2) & 0x03;
  return [100, 75, 50, 25][code];
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (bytes.length !== 12) {
    return { errors: ['expected 12-byte EN307 frame, got ' + bytes.length] };
  }
  if (bytes[3] !== 0x0d) {
    return { errors: ['unexpected device type 0x' + bytes[3].toString(16) + ' (expected 0x0d EN307)'] };
  }

  var data = {};
  // 4-20 mA loop current: raw is µA, normalize to mA (analog.current is mA).
  data.analog = { current: round(signed16(bytes[6], bytes[7]) / 1000, 3) };
  data.batteryPercent = batteryPercentFromState(bytes[10], bytes[11]);
  data.deviceId = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  data.sequenceCounter = bytes[4];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "enless-wireless", model: "tx-analog-600-035" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enless-wireless";
    result.data.model = "tx-analog-600-035";
  }
  return result;
}
