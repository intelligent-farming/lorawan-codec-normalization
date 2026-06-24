// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Ewattch Ambiance (indoor 5-in-1 sensor:
// temperature, humidity, CO2, luminosity/lux, presence/motion).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Ported and
// normalized from the upstream Apache-2.0-distributed BSD-3-Clause decoder
// (TheThingsNetwork/lorawan-devices vendor/ewattch/ewattchlorawandecoder.js,
// "Lorawan Ewattch Javascript Decoder", attributed in NOTICE). We author the
// normalization ourselves and do NOT reuse the upstream array output.
//
// Wire format (Ewattch object TLV stream). A measurement uplink leads with a
// frame byte (0x00 = measurement data frame) followed by a payload-size byte
// equal to the number of TLV bytes that follow. Each object then starts with a
// type byte: bit 0 (0x01) signals that a socket/channel byte follows
// (socket = (b >> 5) & 7, channel = b & 31); bit 7 (0x80) marks a sensor error
// for that object (no value, one filler byte consumed); the object key is
// (b & 0x7E). Multi-byte values are little-endian.
//
// Object keys handled for Ambiance:
//   0x00 temperature  signed16 LE / 100  -> air.temperature (degC)
//   0x04 humidity      byte / 2           -> air.relativeHumidity (%)
//   0x08 CO2           u16 LE             -> air.co2 (ppm)
//   0x10 luminosity    u16 LE             -> air.lightIntensity (lux)
//   0x14 motion        10 * u16 LE        -> action.motion (seconds since last
//                                            motion; see below)
//   0x74 battery       1 byte             -> batteryPercent (extra; see below)
//
// Battery: the Ambiance battery object (0x74) is a single-byte 0-100 charge
// level, not a voltage, so it is emitted as the camelCase extra `batteryPercent`
// rather than forced into the vocabulary `battery` (which is volts). NOTE: the
// upstream decoder has a bug here -- it returns the whole remaining byte array
// (`value: e`) instead of the byte (`e[0]`), so upstream emits a useless `[]`;
// we decode the byte as intended.
//
// Motion: the Ambiance presence object (0x14) reports the time in seconds since
// the last motion was detected (10 s resolution), not an event count. We expose
// action.motion.detected (motion is being reported by the presence sensor) and
// carry the raw timer as the camelCase extra `secondsSinceMotion`.

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
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  // Measurement frames lead with 0x00; non-zero leading bytes are configuration
  // / info frames (node type, firmware version, periodicity) that this
  // normalized codec does not model.
  if (bytes[0] !== 0x00) {
    return { errors: ['unsupported frame type: 0x' + bytes[0].toString(16)] };
  }

  var size = bytes[1];
  if (size !== bytes.length - 2) {
    return { errors: ['Payload size indicated does not match payload size given'] };
  }

  var data = {};
  var air = {};
  var action = {};
  var motion = {};
  var recognized = false;

  var i = 2;
  while (i < bytes.length) {
    var typeByte = bytes[i];
    var key = typeByte & 0x7e;
    var hasError = (typeByte & 0x80) === 0x80;
    var hasAddr = (typeByte & 0x01) === 0x01;
    i += 1;

    // Optional socket/channel addressing byte. The Ambiance reports on a single
    // logical socket/channel, so the address is consumed but not surfaced.
    if (hasAddr) {
      i += 1;
    }

    // A sensor-error object carries no value, just one filler byte.
    if (hasError) {
      i += 1;
      recognized = true;
      continue;
    }

    if (key === 0x00) {
      // Temperature: signed16 LE, hundredths of a degree.
      air.temperature = round(s16le(bytes[i], bytes[i + 1]) / 100, 2);
      i += 2;
      recognized = true;
    } else if (key === 0x04) {
      // Relative humidity: 1 byte, half-percent steps.
      air.relativeHumidity = round(bytes[i] / 2, 1);
      i += 1;
      recognized = true;
    } else if (key === 0x08) {
      // CO2: u16 LE, ppm.
      air.co2 = u16le(bytes[i], bytes[i + 1]);
      i += 2;
      recognized = true;
    } else if (key === 0x10) {
      // Luminosity: u16 LE, lux.
      air.lightIntensity = u16le(bytes[i], bytes[i + 1]);
      i += 2;
      recognized = true;
    } else if (key === 0x14) {
      // Motion: u16 LE * 10 = seconds since last motion detected.
      var seconds = 10 * u16le(bytes[i], bytes[i + 1]);
      motion.detected = true;
      data.secondsSinceMotion = seconds;
      action.motion = motion;
      i += 2;
      recognized = true;
    } else if (key === 0x74) {
      // Battery: 1 byte charge level (0-100), not volts -> batteryPercent.
      data.batteryPercent = bytes[i];
      i += 1;
      recognized = true;
    } else {
      // Unknown object type: stop to avoid misaligned decoding.
      return { errors: ['unknown object type : ' + ('0' + key.toString(16)).slice(-2).toUpperCase()] };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Ewattch objects'] };
  }

  if (air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.co2 !== undefined ||
    air.lightIntensity !== undefined) {
    data.air = air;
  }
  if (action.motion !== undefined) {
    data.action = action;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "ewattch";
    result.data.model = "ambiance";
  }
  return result;
}
