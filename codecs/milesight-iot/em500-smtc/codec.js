// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM500-SMTC (Soil Moisture,
// Temperature & Electrical Conductivity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/em500-smtc.js, attributed in NOTICE).
//
// VERIFIED UPSTREAM BUG: the upstream decoder advances its index by 2 on the
// 1-byte humidity channel (0x04/0x68), which misaligns the stream and silently
// drops the conductivity channel (0x05/0x7F) — its own example output has no
// conductivity even though the wire carries it. This codec advances by the
// correct 1 byte, recovering soil.ec. Battery is a percentage (-> batteryPercent
// extra; the vocabulary `battery` is volts). Conductivity is uS/cm -> dS/m.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var data = {};
  var soil = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x01 && type === 0x75) {
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      soil.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // 1-byte humidity (0.5 % resolution). Upstream advances 2 here; we do not.
      soil.moisture = round(bytes[i + 2] / 2, 1);
      i += 3;
      recognized = true;
    } else if (channel === 0x05 && type === 0x7f) {
      soil.ec = round(u16le(bytes[i + 2], bytes[i + 3]) / 1000, 3);
      i += 4;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }
  if (
    soil.temperature !== undefined ||
    soil.moisture !== undefined ||
    soil.ec !== undefined
  ) {
    data.soil = soil;
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "em500-smtc";
  }
  return result;
}
