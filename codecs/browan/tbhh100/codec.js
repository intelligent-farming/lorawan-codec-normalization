// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Browan TBHH100 (Tabs Healthy Home —
// Temperature & Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed little-endian layout: status, battery level, temperature,
// humidity) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/tbhh100.js, attributed in
// NOTICE). Ported from that upstream decodeUplink; the normalization here is
// authored for this module — do NOT treat upstream normalization as our output.
//
// Browan reports battery as a 4-bit level mapped onto volts:
// (25 + level) / 10 yields 2.5 V .. 4.0 V, which matches the vocabulary's
// `battery` (volts), so it is emitted there directly. The device status field
// (upper 5 bits of byte 0) has no vocabulary key and is emitted as the
// camelCase extra `status`.
//
// Uplinks arrive on FPort 103. Upstream returns a bare {} for an empty/all-zero
// payload; that violates this module's output contract (never return bare {}),
// so an empty payload is reported as an error instead.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  var allZero = true;
  var i;
  for (i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (bytes.length === 0 || allZero) {
    return { errors: ['empty payload'] };
  }

  if (input.fPort !== 103) {
    return { errors: ['unknown FPort'] };
  }

  if (bytes.length < 4) {
    return { errors: ['payload too short'] };
  }

  var status = bytes[0] >> 3;
  var battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);
  var temperature = (bytes[2] & 0x7f) - 32;
  var humidity = bytes[3] & 0x7f;

  return {
    data: {
      battery: battery,
      status: status,
      air: {
        temperature: round(temperature, 1),
        relativeHumidity: round(humidity, 1)
      }
    }
  };
}
