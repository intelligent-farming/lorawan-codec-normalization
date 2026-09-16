// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for comtac LPN-KM (short-circuit / digital-input
// monitor with pulse counters).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/comtac/lpn-km.js, attributed in
// NOTICE). Upstream emits a deeply nested config/diagnostic object; this module
// normalizes only the input measurements and does NOT copy upstream.
//
// Every frame starts with a 4-byte device header: byte0 = device id (0x10 for
// LPN-KM; ids with bit7 set are two bytes -- not used by this device), byte1 =
// device version (0 supported), byte2 = status flags, byte3 = battery level
// (1..254 mapped to 0..100 %, 0 = external power, 255 = error). fPort selects
// the payload:
//   fPort 20 (DI_DATA): 4-byte timestamp, then 4-byte digital-input objects.
//     Object byte0: bit4 = single-point, bit5 = double-point, low nibble = id.
//     Object byte1: bit0 = contact state. We report the FIRST input's state as
//     action.contactState (1 -> "closed"/shorted, 0 -> "open").
//   fPort 21 (CNT_DATA): repeating groups of [count, 4-byte timestamp, then
//     `count` 5-byte counters]. Counter byte0 low nibble = id, byte1 status,
//     bytes2..4 = 24-bit value. The first counter's value -> pulse.total.
// Config/info/timesync ports (3, 22, 100, 101) carry no input measurement and
// are reported as errors. Battery here is a PERCENTAGE, so it is emitted as the
// extra `batteryPercent` (vocabulary `battery` is volts).

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (!bytes || bytes.length < 4) {
    return { errors: ['payload too short for an LPN-KM header'] };
  }

  var deviceId = bytes[0];
  if (deviceId & 0x80) {
    return { errors: ['unsupported extended device id'] };
  }
  if (deviceId !== 0x10) {
    return { errors: ['unsupported device id 0x' + deviceId.toString(16) + ' (expected 0x10 LPN-KM)'] };
  }
  var deviceVersion = bytes[1];
  if (deviceVersion !== 0) {
    return { errors: ['unsupported device version ' + deviceVersion] };
  }

  var batteryByte = bytes[3];
  var data = {};
  if (batteryByte !== 0 && batteryByte !== 255) {
    data.batteryPercent = Math.round(((batteryByte - 1) * 100) / (254 - 1));
  }

  var p = 4;

  if (fPort === 20) {
    // DI_DATA: 4-byte absolute timestamp, then 4-byte DI objects.
    if (bytes.length < p + 4 + 4) {
      return { errors: ['DI_DATA payload too short'] };
    }
    p += 4;
    var diType = bytes[p];
    var state = bytes[p + 1] & 0x01;
    if ((diType & 0x10) === 0 && (diType & 0x20) === 0) {
      return { errors: ['DI_DATA: no single/double-point info object'] };
    }
    data.action = { contactState: state ? 'closed' : 'open' };
    data.inputId = diType & 0x0f;
    return { data: data };
  }

  if (fPort === 21) {
    // CNT_DATA: [count][4-byte ts][count x 5-byte counter].
    if (bytes.length < p + 1 + 4 + 5) {
      return { errors: ['CNT_DATA payload too short'] };
    }
    var objectCount = bytes[p];
    p += 1;
    if (objectCount < 1) {
      return { errors: ['CNT_DATA: no counters'] };
    }
    p += 4; // common timestamp
    var value = (bytes[p + 2] << 16) + (bytes[p + 3] << 8) + bytes[p + 4];
    data.pulse = { total: value };
    data.inputId = bytes[p] & 0x0f;
    return { data: data };
  }

  if (fPort === 3) {
    return { errors: ['FIXED_DATA config frame is not an input measurement'] };
  }
  return { errors: ['unsupported fPort ' + fPort + ' (expected 20 DI_DATA or 21 CNT_DATA)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "comtac", model: "lpn-km" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "comtac";
    result.data.model = "lpn-km";
  }
  return result;
}
