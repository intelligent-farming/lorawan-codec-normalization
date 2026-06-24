// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for AtomSenses AS-201 (3-in-1 Indoor Ambient
// Environment Sensor: temperature / humidity / CO2).
//
// Ported and normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/atomsenses/as-201.js, attributed in
// NOTICE). The wire format is a Milesight-style channel/type TLV stream; the
// channel layout below is ported faithfully from that upstream decoder, which
// is the source of truth for the field layout.
//
// AtomSenses reports battery as a PERCENTAGE on channel 0x01/0x75 (the TTN
// example byte 0x5C decodes to 92), so it is emitted as the camelCase extra
// `batteryPercent` rather than being forced into the vocabulary `battery`
// field (which is volts).

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
  var air = {};
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    // BATTERY (percentage)
    if (channel === 0x01 && type === 0x75) {
      data.batteryPercent = bytes[i + 2];
      i += 3;
      recognized = true;
    // TEMPERATURE (0.1 degC, signed LE)
    } else if (channel === 0x03 && type === 0x67) {
      air.temperature = round(s16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    // HUMIDITY (0.5 % steps)
    } else if (channel === 0x04 && type === 0x68) {
      air.relativeHumidity = round(bytes[i + 2] / 2, 1);
      i += 3;
      recognized = true;
    // PIR / activity (count, unsigned LE) - vocabulary has no field for this
    } else if (channel === 0x05 && type === 0x6a) {
      data.activity = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    // LIGHT (illuminance lux + IR sub-channels, all unsigned LE)
    } else if (channel === 0x06 && type === 0x65) {
      air.lightIntensity = u16le(bytes[i + 2], bytes[i + 3]);
      data.infraredAndVisible = u16le(bytes[i + 4], bytes[i + 5]);
      data.infrared = u16le(bytes[i + 6], bytes[i + 7]);
      i += 8;
      recognized = true;
    // CO2 (ppm, unsigned LE)
    } else if (channel === 0x07 && type === 0x7d) {
      air.co2 = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    // TVOC (unsigned LE) - vocabulary models only air.co2, so this is an extra
    } else if (channel === 0x08 && type === 0x7d) {
      data.tvoc = u16le(bytes[i + 2], bytes[i + 3]);
      i += 4;
      recognized = true;
    // PRESSURE (0.1 hPa, unsigned LE)
    } else if (channel === 0x09 && type === 0x73) {
      air.pressure = round(u16le(bytes[i + 2], bytes[i + 3]) / 10, 1);
      i += 4;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized AtomSenses channels'] };
  }

  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.co2 !== undefined ||
    air.lightIntensity !== undefined ||
    air.pressure !== undefined
  ) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atomsenses";
    result.data.model = "as-201";
  }
  return result;
}
