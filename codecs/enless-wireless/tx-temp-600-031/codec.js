// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for enless-wireless/tx-temp-600-031
// (EN305, "TX TEMP INS 600-031" — rugged sensor with integrated temperature).
//
// Derivation: wire format understood from the upstream Apache-2.0 multi-device
// dispatcher (TheThingsNetwork/lorawan-devices vendor/enless-wireless/
// enlessdecoder.js, attributed in NOTICE). Normalization authored here; the
// upstream flat "values/states/alarm_status" template is NOT copied.
//
// Wire format (all Enless TX frames share a 6-byte header):
//   bytes[0..2]  device id (24-bit)
//   bytes[3]     device type byte (EN305 = 0x07 for this model)
//   bytes[4]     sequence counter
//   bytes[5]     firmware version
// EN305 payload:
//   bytes[6..7]  temperature, big-endian signed-16, tenths -> ÷10 = °C
//   bytes[10..11] alarm-status word (not telemetry)
//   bytes[12..13] state word: bits 2..3 = battery level code
//                 (0=100%,1=75%,2=50%,3=25%); bit 0 = msg alarm flag
// Battery is reported by the device as a coarse 2-bit percentage, not a
// voltage, so it is emitted as the camelCase extra `batteryPercent` (the
// vocabulary `battery` key is volts).

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
    return { errors: ['expected 14-byte EN305 frame, got ' + bytes.length] };
  }
  if (bytes[3] !== 0x07) {
    return { errors: ['unexpected device type 0x' + bytes[3].toString(16) + ' (expected 0x07 EN305)'] };
  }

  var data = {};
  data.temperature = round(signed16(bytes[6], bytes[7]) / 10, 1);
  data.batteryPercent = batteryPercentFromState(bytes[12], bytes[13]);
  data.deviceId = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  data.sequenceCounter = bytes[4];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "enless-wireless", model: "tx-temp-600-031" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enless-wireless";
    result.data.model = "tx-temp-600-031";
  }
  return result;
}
