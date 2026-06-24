// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight EM500-SMT (Soil Moisture & Temperature
// Sensor). The EM500-SMTC twin adds an electrical-conductivity channel; the SMT
// does not carry one.
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/milesight-iot/em500-smt.js,
// attributed in NOTICE). Wire format is the Milesight channel/type TLV stream.
//
// VERIFIED UPSTREAM BUGS recovered here:
//   (1) Index-advance bug: upstream advances its index by 2 on the 1-byte
//       humidity channel (0x04/0x68), misaligning the stream. This codec
//       advances by the correct 1 byte.
//   (2) Missing temperature channel: the upstream EM500-SMT decoder has no
//       handler for the soil-temperature channel (0x03/0x67) even though the
//       device and its datasheet report it (the SMTC twin decodes it). This
//       codec decodes it using the family-standard signed int16 LE / 10.
//
// Mapping: soil volumetric moisture (%) -> soil.moisture; soil temperature
// (degC) -> soil.temperature. Milesight reports battery as a PERCENTAGE; the
// vocabulary `battery` is volts, so the percentage is emitted as the camelCase
// extra `batteryPercent` rather than forced into a volts field.

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
      // BATTERY (percentage)
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    } else if (channel === 0x03 && type === 0x67) {
      // SOIL TEMPERATURE (degC, 0.1 resolution, signed int16 LE)
      soil.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else if (channel === 0x04 && type === 0x68) {
      // SOIL MOISTURE / VWC (%, 0.5 resolution, 1 byte). Upstream advances 2
      // here; we advance the correct 1.
      soil.moisture = round(bytes[i + 2] / 2, 1);
      i += 3;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }
  if (soil.temperature !== undefined || soil.moisture !== undefined) {
    data.soil = soil;
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "em500-smt";
  }
  return result;
}
