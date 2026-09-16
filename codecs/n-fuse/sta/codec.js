// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the n-fuse STA (Action Button with tactile
// feedback, compact form factor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/n-fuse/sta.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream decodeUplink.
// NOTE: upstream's version guard `bytes[0] & 0xc0 != 0x40` is misparsed by JS
// operator precedence (it evaluates to `bytes[0] & 1`); this codec applies the
// correct check `(bytes[0] & 0xc0) === 0x40`.
//
// fPort 1 frame:
//   bytes[0] bits7:6  protocol version (must be 0b01)
//   bytes[0] bits5:2  TX power (rp002 index)        -> extra `txPower`
//   bytes[0] bit1     trigger high bit
//   bytes[0] bit0     "triggered" flag (1 = an action/press caused this uplink)
//   bytes[1] bit7     trigger low-source bit
//   bytes[1] bits6:0  battery: value / 100 + 2 (volts)
//   bytes[2]          MCU temperature: value / 255 * 165 - 40 (degrees C)
//                     -> extra `mcuTemperature`
//   bytes[3]          gesture count (present only when triggered)
//
// Trigger code -> gesture: 1=Single Press, 2=Double Press, 3=Long Press.
// Code 0 is a scheduled (RTC) interval report, not a press.
//   Single -> action.button.event "single", pressed true
//   Double -> action.button.event "double", pressed true
//   Long   -> action.button.event "long",   pressed true
//   RTC    -> pressed false (no event)
// action.button.count carries the gesture count for a press.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 1)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['expected at least 3 bytes, got ' + (bytes ? bytes.length : 0)] };
  }
  if ((bytes[0] & 0xc0) !== 0x40) {
    return { errors: ['unknown format version (top two bits of byte 0 must be 0b01)'] };
  }

  var data = {};

  data.version = 1;
  data.txPower = (bytes[0] >> 2) & 0x0f;
  data.battery = round((bytes[1] & 0x7f) / 100 + 2, 2);
  data.mcuTemperature = round(bytes[2] / 255 * 165 - 40, 2);

  // Trigger: bit0 of byte0 signals an action; the 2-bit source code is built
  // from byte1 bit7 (high) and byte0 bit1 (low).
  var triggered = (bytes[0] & 0x01) === 1;
  if (triggered) {
    var code = (((bytes[1] >> 6) & 0x02) | ((bytes[0] >> 1) & 0x01)) + 1;
    var gestureCount = bytes.length > 3 ? bytes[3] : 0;
    var eventName;
    if (code === 1) {
      eventName = 'single';
    } else if (code === 2) {
      eventName = 'double';
    } else if (code === 3) {
      eventName = 'long';
    } else {
      return { errors: ['unknown trigger code ' + code] };
    }
    data.action = { button: { pressed: true, event: eventName, count: gestureCount } };
  } else {
    data.action = { button: { pressed: false } };
    data.scheduledReport = true;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "n-fuse", model: "sta" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "n-fuse";
    result.data.model = "sta";
  }
  return result;
}
