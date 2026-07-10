// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for enless-wireless/tx-contact-600-039
// (EN319, "TX CONTACT 600-039" — digital dry-contact / state transmitter).
//
// Derivation: wire format understood from the upstream Apache-2.0 multi-device
// dispatcher (TheThingsNetwork/lorawan-devices vendor/enless-wireless/
// enlessdecoder.js, attributed in NOTICE). Normalization authored here; the
// upstream flat "values/states/alarm_status" template is NOT copied. EN319
// shares the EN308 pulse frame layout, but its telemetry of interest is the
// digital input contact state carried in the state word (not the counters).
//
// Wire format (shared 6-byte Enless header):
//   bytes[0..2]    device id (24-bit)
//   bytes[3]       device type byte (EN319 = 0x0B)
//   bytes[4]       sequence counter
//   bytes[5]       firmware version
// EN319 payload:
//   bytes[6..9]    channel 1 transition counter (cumulative, big-endian uint32)
//   bytes[10..13]  channel 2 transition counter
//   bytes[14..17]  open-collector (OC) transition counter
//   bytes[18..19]  alarm-status word (not telemetry)
//   bytes[20..21]  state word: bit 4 = ch1 contact (0=open,1=closed),
//                  bit 5 = ch2, bit 6 = OC; bits 2..3 = battery level code
//                  (0=100%,1=75%,2=50%,3=25%)
// Channel 1 digital state maps to the vocabulary action.contactState; the other
// channels' states and the transition counters are camelCase extras. Battery is
// a coarse 2-bit percentage, not a voltage, so it is emitted as `batteryPercent`
// (the vocabulary `battery` key is volts).

var DEVICE_TYPE = 0x0b;

function uint32(bytes, o) {
  return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
}

function contactState(word, mask) {
  return word & mask ? 'closed' : 'open';
}

function batteryPercentFromState(word) {
  var code = (word >> 2) & 0x03;
  return [100, 75, 50, 25][code];
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (bytes.length !== 22) {
    return { errors: ['expected 22-byte EN319 frame, got ' + bytes.length] };
  }
  if (bytes[3] !== DEVICE_TYPE) {
    return { errors: ['unexpected device type 0x' + bytes[3].toString(16) + ' (expected 0x0b EN319)'] };
  }

  var stateWord = (bytes[20] << 8) | bytes[21];

  var data = {};
  data.action = { contactState: contactState(stateWord, 0x10) };
  data.channel2ContactState = contactState(stateWord, 0x20);
  data.ocContactState = contactState(stateWord, 0x40);
  data.channel1Count = uint32(bytes, 6);
  data.channel2Count = uint32(bytes, 10);
  data.ocCount = uint32(bytes, 14);
  data.batteryPercent = batteryPercentFromState(stateWord);
  data.deviceId = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  data.sequenceCounter = bytes[4];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enless-wireless";
    result.data.model = "tx-contact-600-039";
  }
  return result;
}
