// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Mutelcor NFC RFID - LoRa Button
// (MTC-NFC02): a LoRa button that can attach an NFC/RFID tag UID to the alarm
// raised when the button is pressed.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mutelcor/mutelcor.js, the shared
// Mutelcor LoRaButton decoder, attributed in NOTICE). Author the normalization
// here; do NOT copy upstream decodeUplink.
//
// Mutelcor LoRaButton common header:
//   bytes[0]        payload version
//   bytes[1..2]     battery / input voltage, big-endian, in 0.01 V
//   bytes[3]        opcode: 0 = Heartbeat, 1 = Alarm (button press)
// Alarm (opcode 1) frame:
//   bytes[4]        button bitmask (bit N -> button N+1)
//   bytes[5..6]     alarm id (optional, big-endian)      -> extra `alarmId`
//   bytes[7]        NFC UID type (optional; 255 == none)
//   bytes[8..]      NFC tag UID bytes                     -> extra `nfcUid`
//
// A press is the Alarm opcode: action.button.pressed = true,
// action.button.event "single", action.button.count = number of buttons in the
// mask. Heartbeat reports pressed = false. Opcode, pressed button list, alarm
// id, and NFC UID are kept as camelCase extras. Other opcodes are not press
// telemetry and error out.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function toHexByte(b) {
  return ('0' + b.toString(16).toUpperCase()).slice(-2);
}

function buttonsFromMask(mask) {
  var list = [];
  for (var i = 0; i < 8; i++) {
    if (mask & (1 << i)) {
      list.push(i + 1);
    }
  }
  return list;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 4) {
    return { errors: ['expected at least 4 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data = {};
  data.payloadVersion = bytes[0];
  data.battery = round(((bytes[1] * 256) + bytes[2]) / 100, 2);

  var opcode = bytes[3];
  data.opcode = opcode;

  if (opcode === 1) {
    var pos = 4;
    var mask = 0;
    if (pos < bytes.length) {
      mask = bytes[pos];
      pos += 1;
    }
    var buttons = buttonsFromMask(mask);
    data.buttons = buttons;

    // Optional alarm id (2 bytes).
    if (pos + 1 < bytes.length) {
      data.alarmId = (bytes[pos] * 256) + bytes[pos + 1];
      pos += 2;
    }
    // Optional NFC UID: uidType byte followed by the tag UID bytes. Type 255
    // means "no UID" (a UID read error would follow instead).
    if (pos < bytes.length) {
      var uidType = bytes[pos];
      pos += 1;
      if (uidType !== 255) {
        var uid = toHexByte(uidType);
        for (var j = pos; j < bytes.length; j++) {
          uid += toHexByte(bytes[j]);
        }
        data.nfcUid = uid;
      }
    }

    data.action = { button: { pressed: true, event: 'single', count: buttons.length } };
    return { data: data };
  }
  if (opcode === 0) {
    data.action = { button: { pressed: false } };
    return { data: data };
  }

  return { errors: ['unsupported opcode ' + opcode + ' (not a button press or heartbeat)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mutelcor";
    result.data.model = "mtc-nfc02";
  }
  return result;
}
