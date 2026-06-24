// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs AgroSense Light Intensity Sensor
// (model AGLWL01).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/light-intensity.js and the
// Makerfabs Agrosense-Decoder TTN.js, attributed in NOTICE). Do NOT copy
// upstream normalization.
//
// Fixed-layout payload (Makerfabs AgroSense Light Intensity manual V1.2, 3.1.2):
//   bytes[0..1] uint16 BE  packet sequence number (0..65535) -> seqNo extra
//   bytes[2]    uint8       battery voltage x10 -> battery (V) (e.g. 0x1D=29 -> 2.9 V)
//   bytes[3..6] uint32 BE   illuminance x100 -> air.lightIntensity (lux)
//                           (e.g. 0x000022D4=8916 -> 89.16 lux)
//   bytes[7..]  trailing interval / NC / upload-flag bytes are ignored here.
//
// Battery is reported as VOLTS on this device (byte/10), so it maps to the
// vocabulary `battery` (V) directly -- not batteryPercent.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(b0, b1) {
  return ((b0 << 8) | b1) >>> 0;
}

function u32be(b0, b1, b2, b3) {
  return ((b0 * 16777216) + (b1 << 16) + (b2 << 8) + b3) >>> 0;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 7) {
    return { errors: ['payload too short: expected at least 7 bytes'] };
  }

  var data = {};

  data.seqNo = u16be(bytes[0], bytes[1]);
  data.battery = round(bytes[2] / 10, 1);

  var air = {};
  air.lightIntensity = round(u32be(bytes[3], bytes[4], bytes[5], bytes[6]) / 100, 2);
  data.air = air;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "light-intensity";
  }
  return result;
}
