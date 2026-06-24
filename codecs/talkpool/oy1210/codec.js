// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TalkPool OY1210 (indoor temperature, humidity
// and CO2 monitor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/talkpool/oy1210.js, attributed in
// NOTICE). Authored here; the upstream `decodeUplink` is reference only.
//
// Wire format (fPort 2, exactly 5 bytes [b0 b1 b2 b3 b4], 12-bit packed):
//   temperature raw = (b0 << 4) | (b2 >> 4)    -> raw/10 - 80  (°C)
//   humidity    raw = (b1 << 4) | (b2 & 0x0f)  -> raw/10 - 25  (%RH)
//   co2             = (b3 << 8) | b4           (ppm)
// The OY1210 reports no battery in its uplink, so no battery field is emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 2) {
    return { errors: ['unsupported fPort ' + port + ' (expected 2)'] };
  }
  if (!bytes || bytes.length !== 5) {
    return { errors: ['expected 5 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var tempRaw = (bytes[0] << 4) | (bytes[2] >> 4);
  var humRaw = (bytes[1] << 4) | (bytes[2] & 0x0f);
  var co2 = (bytes[3] << 8) | bytes[4];

  var air = {};
  air.temperature = round(tempRaw / 10 - 80, 1);
  air.relativeHumidity = round(humRaw / 10 - 25, 1);
  air.co2 = co2;

  return { data: { air: air } };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "talkpool";
    result.data.model = "oy1210";
  }
  return result;
}
