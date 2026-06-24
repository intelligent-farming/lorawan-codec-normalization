// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec MOVE (indoor environment + presence
// sensor: temperature, humidity, brightness/lux, motion/occupancy, noise).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec bit-packed periodic frame: product byte, message type, then
// MSB-first bit fields) was ported from and normalized against the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nexelec/sign-codec.js, attributed in NOTICE). The upstream bit-slicing
// (hex-string substring extraction) is reproduced exactly; only the periodic
// data message (type 0x01) for the MOVE product (0xAB) is handled here.
//
// Field mapping (periodic frame, MSB-first bit offsets within the payload that
// follows the 2-byte header):
//   temperature   bits  0..9  (10b) value = code/10 - 30 °C  -> air.temperature
//   humidity      bits 10..19 (10b) value = code/10 %RH      -> air.relativeHumidity
//   luminosity    bits 48..57 (10b) value = code*5 lux       -> air.lightIntensity (genuine lux)
//   button        bit  58     ( 1b)                          -> buttonPressed (extra)
//   averageNoise  bits 59..65 ( 7b) value = code dB          -> averageNoiseDb (extra)
//   peakNoise     bits 66..72 ( 7b) value = code dB          -> peakNoiseDb (extra)
//   occupancyRate bits 73..79 ( 7b) value = code %           -> action.motion + occupancyPercent (extra)
// (CO2 / COVT bit fields exist in the shared Nexelec frame but the MOVE has no
// such sensors, so they are not decoded here.)
//
// Sentinel / sensor-absent codes are honored: for the 10-bit fields 1021 =
// deactivated, 1022 = disconnected, 1023 = error; for the 7-bit fields 125 =
// deactivated, 126 = disconnected, 127 = error. At any sentinel the field is
// suppressed rather than emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    s += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

// A 10-bit field is "absent" at 1021 (deactivated), 1022 (disconnected),
// 1023 (error); a 7-bit field is "absent" at 125, 126, 127.
function present10(code) {
  return code < 1021;
}
function present7(code) {
  return code < 125;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 12) {
    return { errors: ['payload too short for a Nexelec periodic frame'] };
  }

  var hex = bytesToHex(bytes);
  var product = parseInt(hex.substring(0, 2), 16);
  var messageType = parseInt(hex.substring(2, 4), 16);

  if (product !== 0xab) {
    return { errors: ['unexpected product byte (expected 0xAB for Nexelec MOVE)'] };
  }
  if (messageType !== 0x01) {
    return { errors: ['unsupported message type (only periodic data 0x01 is decoded)'] };
  }

  // Bit-field extraction ported verbatim from the upstream periodic decoder.
  var tempCode = (parseInt(hex.substring(4, 8), 16) >> 6) & 0x3ff;
  var humCode = parseInt(hex.substring(6, 9), 16) & 0x3ff;
  var luxCode = (parseInt(hex.substring(16, 19), 16) >> 2) & 0x3ff;
  var buttonCode = (parseInt(hex.substring(18, 19), 16) >> 1) & 0x01;
  var avgNoiseCode = (parseInt(hex.substring(18, 21), 16) >> 2) & 0x7f;
  var peakNoiseCode = (parseInt(hex.substring(20, 23), 16) >> 3) & 0x7f;
  var occupancyCode = parseInt(hex.substring(22, 24), 16) & 0x7f;

  var data = {};
  var air = {};

  if (present10(tempCode)) {
    air.temperature = round(tempCode / 10 - 30, 1);
  }
  if (present10(humCode)) {
    air.relativeHumidity = round(humCode / 10, 1);
  }
  if (present10(luxCode)) {
    air.lightIntensity = luxCode * 5;
  }
  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.lightIntensity !== undefined
  ) {
    data.air = air;
  }

  if (present7(occupancyCode)) {
    data.action = { motion: { detected: occupancyCode > 0 } };
    data.occupancyPercent = occupancyCode;
  }

  if (present7(avgNoiseCode)) {
    data.averageNoiseDb = avgNoiseCode;
  }
  if (present7(peakNoiseCode)) {
    data.peakNoiseDb = peakNoiseCode;
  }

  data.buttonPressed = buttonCode === 1;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "nexelec";
    result.data.model = "move";
  }
  return result;
}
