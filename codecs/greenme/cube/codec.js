// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for GreenMe Cube (indoor comfort / environment
// sensor: temperature, humidity, CO2, illuminance, noise, light color, TVOC).
//
// Ported and normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/greenme/cube.js, attributed in
// NOTICE). The upstream decodeUplink dispatch on the header byte's low nibble
// (SHORT=5, FULL=6, FEEL=7 message types, plus an extended-sensor sub-type for
// CO2/TVOC) is reproduced faithfully; the decoded fields are then mapped onto
// the shared vocabulary. Do NOT copy upstream normalizeUplink output.
//
// Mapping to vocabulary:
//   temperature  -> air.temperature        (already degrees C)
//   hygrometry   -> air.relativeHumidity   (percent)
//   co2          -> air.co2                 (ppm)
//   lux          -> air.lightIntensity      (genuine numeric lux, 16-bit raw)
// Everything else the Cube reports has no vocabulary key and is emitted as a
// camelCase extra: noiseMax/noiseAvg (dBA sound level), tvoc, flicker,
// lightColorR/G/B/W, octave1..octave9 (sound spectrum bands), and lastFeel
// (the device's comfort-button feedback state: 1 = unhappy, -1 = happy,
// 0 = unknown). The Cube has no battery telemetry in its uplinks (the battery
// byte is reserved/unused upstream) and reports no presence/motion, so neither
// `battery`, `batteryPercent`, nor `action.motion` is emitted.

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Mirrors upstream ValidateMessageSize: checks the header's message type, the
// fixed body length for that type, and the extended-sensor sub-type byte.
function validateMessageSize(bytes) {
  var MESSAGEV2_SHORT = 5;
  var MESSAGEV2_FULL = 6;
  var MESSAGEV2_FEEL = 7;

  var bodySize;
  var msgType = bytes[0] & 0x0f;
  if (msgType === MESSAGEV2_SHORT) {
    bodySize = 11;
  } else if (msgType === MESSAGEV2_FULL || msgType === MESSAGEV2_FEEL) {
    bodySize = 26;
  } else {
    return false;
  }

  var msgSize = bytes.length;
  if (msgSize < bodySize) {
    return false;
  }

  var extType = bytes[bodySize - 1];
  var extSize;
  if (extType === 0) {
    extSize = 0;
  } else if (extType === 1 || extType === 2) {
    extSize = 2;
  } else if (extType === 3) {
    extSize = 4;
  } else {
    return false;
  }

  return msgSize === bodySize + extSize;
}

function decodeUplinkCore(input) {
  var MESSAGEV2_SHORT = 5;
  var MESSAGEV2_FULL = 6;
  var MESSAGEV2_FEEL = 7;
  var MESSAGEEXT_CO2ONLY = 1;
  var MESSAGEEXT_COVONLY = 2;
  var MESSAGEEXT_COV_CO2 = 3;

  var FEEL_UNHAPPY = 1;
  var FEEL_HAPPY = -1;
  var FEEL_UNKNOWN = 0;

  var bytes = input.bytes;

  if (!validateMessageSize(bytes)) {
    return { errors: ['invalid message size'] };
  }

  var data = {};
  var air = {};
  var i = 0;

  // Header
  var header = bytes[i];
  i++;

  var feelBits = header & 0xc0;
  if (feelBits === 0x40) {
    data.lastFeel = FEEL_UNHAPPY;
  } else if (feelBits === 0x80) {
    data.lastFeel = FEEL_HAPPY;
  } else {
    data.lastFeel = FEEL_UNKNOWN;
  }

  var messageType = header & 0x0f;

  // Common block (SHORT / FULL / FEEL).
  air.temperature = round(u16le(bytes[i], bytes[i + 1]) / 100, 2);
  i += 2;
  air.relativeHumidity = round(u16le(bytes[i], bytes[i + 1]) / 100, 2);
  i += 2;
  data.noiseMax = bytes[i] / 2;
  i++;
  data.noiseAvg = bytes[i] / 2;
  i++;
  air.lightIntensity = u16le(bytes[i], bytes[i + 1]);
  i += 2;

  // FULL / FEEL extended block: light color, flicker and the 9 sound octaves.
  if (messageType === MESSAGEV2_FULL || messageType === MESSAGEV2_FEEL) {
    data.lightColorR = bytes[i] & 0xff;
    i++;
    data.lightColorG = bytes[i] & 0xff;
    i++;
    data.lightColorB = bytes[i] & 0xff;
    i++;
    data.lightColorW = u16le(bytes[i], bytes[i + 1]);
    i += 2;
    data.flicker = bytes[i];
    i++;
    data.octave1 = bytes[i];
    i++;
    data.octave2 = bytes[i];
    i++;
    data.octave3 = bytes[i];
    i++;
    data.octave4 = bytes[i];
    i++;
    data.octave5 = bytes[i];
    i++;
    data.octave6 = bytes[i];
    i++;
    data.octave7 = bytes[i];
    i++;
    data.octave8 = bytes[i];
    i++;
    data.octave9 = bytes[i];
    i++;
  }

  // Battery level/status byte: reserved/unused upstream.
  i++;

  // Extended-sensor sub-message: CO2 and/or TVOC.
  var extMsgType = bytes[i];
  i++;
  if (extMsgType === MESSAGEEXT_CO2ONLY) {
    air.co2 = u16le(bytes[i], bytes[i + 1]);
    i += 2;
  } else if (extMsgType === MESSAGEEXT_COVONLY) {
    data.tvoc = u16le(bytes[i], bytes[i + 1]);
    i += 2;
  } else if (extMsgType === MESSAGEEXT_COV_CO2) {
    data.tvoc = u16le(bytes[i], bytes[i + 1]);
    i += 2;
    air.co2 = u16le(bytes[i], bytes[i + 1]);
    i += 2;
  }

  data.air = air;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "greenme";
    result.data.model = "cube";
  }
  return result;
}
