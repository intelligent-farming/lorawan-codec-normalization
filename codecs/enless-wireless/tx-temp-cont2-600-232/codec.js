// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for enless-wireless/tx-temp-cont2-600-232
// (EN306, "TX TEMP CONT2 600-232" — two external PT1000 contact probes).
//
// Derivation: wire format understood from the upstream Apache-2.0 multi-device
// dispatcher (TheThingsNetwork/lorawan-devices vendor/enless-wireless/
// enlessdecoder.js, attributed in NOTICE). Normalization authored here; the
// upstream flat "values/states/alarm_status" template is NOT copied.
//
// Wire format (all Enless TX frames share a 6-byte header):
//   bytes[0..2]  device id (24-bit)
//   bytes[3]     device type byte (EN306 = 0x0C for this model)
//   bytes[4]     sequence counter
//   bytes[5]     firmware version
// EN306 payload (two temperature channels):
//   bytes[6..7]  probe 1 temperature, big-endian signed-16, tenths -> ÷10 = °C
//   bytes[8..9]  probe 2 temperature, big-endian signed-16, tenths -> ÷10 = °C
//   bytes[10..11] alarm-status word (not telemetry)
//   bytes[12..13] state word: bits 2..3 = battery level code
//                 (0=100%,1=75%,2=50%,3=25%); bit 0 = msg alarm flag
// Channel mapping: probe 1 (upstream temperature_1) is the primary channel and
// maps to the top-level vocabulary key `temperature`; probe 2 is exposed as the
// camelCase extra `temperature2` (no vocabulary key for a second probe).
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

  if (bytes.length !== 14) {
    return { errors: ['expected 14-byte EN306 frame, got ' + bytes.length] };
  }
  if (bytes[3] !== 0x0c) {
    return { errors: ['unexpected device type 0x' + bytes[3].toString(16) + ' (expected 0x0c EN306)'] };
  }

  var data = {};
  data.temperature = round(signed16(bytes[6], bytes[7]) / 10, 1);
  data.temperature2 = round(signed16(bytes[8], bytes[9]) / 10, 1);
  data.batteryPercent = batteryPercentFromState(bytes[12], bytes[13]);
  data.deviceId = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  data.sequenceCounter = bytes[4];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enless-wireless";
    result.data.model = "tx-temp-cont2-600-232";
  }
  return result;
}
