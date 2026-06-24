// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for thermokon/dpa-lrw (DPA+ LRW differential
// pressure & volume-flow transducer for air/HVAC).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/thermokon/thermokon-codec.js,
// "Thermokon LPP" payload parser, attributed in NOTICE). The wire format is a
// stream of LPP-style typed channels: each channel is a 1-byte tag when the
// first byte is <= 0x7F, otherwise a 2-byte tag, followed by the channel value.
//
// Differential pressure (LPP_DP, tag 0x31) is reported by the device as a
// signed 16-bit value already calibrated in Pascals -> emitted as-is into
// pressure.differential (Pa). Temperature (LPP_TEMP, tag 0x10) is signed
// deci-degrees Celsius. Battery (LPP_VBAT, tag 0x54) is millivolts. Volume
// flow (LPP_FLOW, tag 0x32) has no vocabulary key -> camelCase extra.
//
// Author the normalization here; do NOT copy upstream normalizeUplink.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16ToS16(u16) {
  var s16 = u16 & 0xffff;
  if (0x8000 & s16) {
    s16 = -(0x010000 - s16);
  }
  return s16;
}

function u8ToS8(u8) {
  var s8 = u8 & 0xff;
  if (0x80 & s8) {
    s8 = -(0x0100 - s8);
  }
  return s8;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var i;

  for (i = 0; i < bytes.length; i++) {
    var tag = 0;
    if (bytes[i] <= 0x7f) {
      tag = bytes[i];
      i++;
    } else {
      tag = (bytes[i] << 8) + bytes[i + 1];
      i += 2;
    }

    switch (tag) {
      case 0x0000: // LPP_PARSER (parser/protocol version)
        data.parserVersion = u16ToS16(bytes[i] << 8 | bytes[i + 1]);
        i++;
        break;
      case 0x0010: // LPP_TEMP — signed deci-degrees C
        data.air = data.air || {};
        data.air.temperature = round(u16ToS16(bytes[i] << 8 | bytes[i + 1]) / 10, 1);
        i++;
        break;
      case 0x0031: // LPP_DP — signed 16-bit, calibrated Pascals
        data.pressure = data.pressure || {};
        data.pressure.differential = u16ToS16(bytes[i] << 8 | bytes[i + 1]);
        i++;
        break;
      case 0x0032: // LPP_FLOW — volume flow (no vocabulary key)
        data.volumeFlow = (bytes[i] << 8 | bytes[i + 1]);
        i++;
        break;
      case 0x0054: // LPP_VBAT — battery in millivolts -> volts
        data.battery = round((bytes[i] * 20) / 1000, 3);
        break;
      default:
        return { errors: ['unsupported channel tag 0x' + tag.toString(16)] };
    }
  }

  var hasAny = false;
  var k;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) {
    return { errors: ['no decodable channels in payload'] };
  }

  return { data: data };
}
