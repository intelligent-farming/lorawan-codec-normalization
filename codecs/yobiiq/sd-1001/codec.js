// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the YOBIIQ iQ SD-1001 (Smoke Detector).
// Data-register reports arrive on fPort 8.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/yobiiq/sd-1001.js, attributed in
// NOTICE). Normalization authored here; upstream decodeDeviceData output is NOT
// copied.
//
// fPort 8 is a channel/type/value TLV stream. Every SD-1001 channel value is a
// single byte, so each entry is 3 bytes: [channel, type(ignored), value].
//   0x01 batteryLevelInPercentage  -> batteryPercent (extra; % not V)
//   0x02 powerEvent (0 off / 1 on) -> powerEvent (extra string)
//   0x03 lowBatteryAlarm           -> lowBatteryAlarm (extra bool)
//   0x04 faultAlarm                -> faultAlarm (extra bool)
//   0x05 smokeAlarm                -> action.smoke.detected (bool, 1 = alarm)
//   0x06 interconnectAlarm         -> interconnectAlarm (extra bool)
//   0x07 testButtonPressed         -> testButtonPressed (extra bool)
// A frame that does not carry the smoke-alarm channel (0x05) — e.g. a basic-
// information frame on fPort 50 / channel 0xFF — is reported as an error, since
// the smoke-detector contract requires action.smoke.detected.

var CHANNEL_SMOKE = 0x05;

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 8) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 8, data register report)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['expected at least 3 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  // Basic-information frames use channel 0xFF and carry no smoke measurement.
  if (bytes[0] === 0xFF) {
    return { errors: ['basic-information frame (no measurement)'] };
  }

  var data = {};
  var smokeSeen = false;
  var i = 0;

  while (i + 3 <= bytes.length) {
    var channel = bytes[i];
    // bytes[i + 1] is the type descriptor (unused); value is bytes[i + 2].
    var value = bytes[i + 2];
    i += 3;

    switch (channel) {
      case 0x01:
        data.batteryPercent = value;
        break;
      case 0x02:
        data.powerEvent = value ? 'AC Power On' : 'AC Power Off';
        break;
      case 0x03:
        data.lowBatteryAlarm = value !== 0;
        break;
      case 0x04:
        data.faultAlarm = value !== 0;
        break;
      case CHANNEL_SMOKE:
        data.action = { smoke: { detected: value !== 0 } };
        smokeSeen = true;
        break;
      case 0x06:
        data.interconnectAlarm = value !== 0;
        break;
      case 0x07:
        data.testButtonPressed = value !== 0;
        break;
      default:
        return { errors: ['unknown data channel 0x' + channel.toString(16)] };
    }
  }

  if (!smokeSeen) {
    return { errors: ['frame does not carry the smoke-alarm channel (0x05)'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "yobiiq";
    result.data.model = "sd-1001";
  }
  return result;
}
