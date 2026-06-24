// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec SIGN (indoor air-quality + presence
// sensor: CO2, temperature, humidity, VOC, brightness/lux, motion/occupancy,
// sound, and IziAir IAQ indices).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec bit-packed periodic frame: product byte, message type, then
// MSB-first bit fields) was ported from and normalized against the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nexelec/sign-codec.js, attributed in NOTICE). The upstream bit-slicing
// (hex-string substring extraction) is reproduced exactly; only the periodic
// data message (type 0x01) for the SIGN product (0xAD, "Sign LoRa") is handled
// here. Unlike the sibling MOVE (0xAB) the SIGN genuinely populates the CO2,
// VOC (COVT), and luminosity bit fields of the shared frame, so they are
// decoded here.
//
// Field mapping (periodic frame, hex-char offsets into the payload that follows
// the 2-byte header, matching the upstream substring/shift extraction):
//   temperature   hex[4:8]  >>6 &0x3FF  (10b) value = code/10 - 30 °C -> air.temperature
//   humidity      hex[6:9]      &0x3FF  (10b) value = code/10 %RH     -> air.relativeHumidity
//   co2           hex[9:13] >>2 &0x3FFF (14b) value = code ppm        -> air.co2
//   covt (VOC)    hex[12:16]    &0x3FFF (14b) value = code ug/m3      -> tvocUgM3 (extra)
//   luminosity    hex[16:19]>>2 &0x3FF  (10b) value = code*5 lux      -> air.lightIntensity (genuine lux)
//   buttonPress   hex[18:19]>>1 &0x01   ( 1b)                         -> buttonPressed (extra)
//   averageNoise  hex[18:21]>>2 &0x7F   ( 7b) value = code dB         -> averageNoiseDb (extra)
//   peakNoise     hex[20:23]>>3 &0x7F   ( 7b) value = code dB         -> peakNoiseDb (extra)
//   occupancyRate hex[22:24]    &0x7F   ( 7b) value = code %          -> action.motion + occupancyPercent (extra)
//   iziAirGlobal  hex[24:26]>>5 &0x07   ( 3b) IAQ index              -> iaqGlobal (extra)
//   iziAirSource  hex[24:26]>>1 &0x0F   ( 4b) IAQ source            -> iaqSource (extra)
//
// Sentinel / sensor-absent codes are honored. For the 10-bit fields (temp,
// humidity, luminosity): 1021 = deactivated, 1022 = disconnected, 1023 = error.
// For the 14-bit fields (co2, covt): 16381 = deactivated, 16382 = disconnected,
// 16383 = error. For the 7-bit fields (noise, occupancy): 125 = deactivated,
// 126 = disconnected, 127 = error. At any sentinel the field is suppressed
// rather than emitted. IziAir index 7 = "Error" and source index 15 = "Error"
// are likewise suppressed.

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
// 1023 (error); a 14-bit field at 16381/16382/16383; a 7-bit field at
// 125/126/127.
function present10(code) {
  return code < 1021;
}
function present14(code) {
  return code < 16381;
}
function present7(code) {
  return code < 125;
}

var IAQ_GLOBAL = ['Excellent', 'Reserved', 'Fair', 'Reserved', 'Bad', 'Reserved', 'Reserved', 'Error'];
var IAQ_SOURCE = ['None', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'CO2', 'VOC',
  'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Error'];

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 12) {
    return { errors: ['payload too short for a Nexelec periodic frame'] };
  }

  var hex = bytesToHex(bytes);
  var product = parseInt(hex.substring(0, 2), 16);
  var messageType = parseInt(hex.substring(2, 4), 16);

  if (product !== 0xad) {
    return { errors: ['unexpected product byte (expected 0xAD for Nexelec SIGN)'] };
  }
  if (messageType !== 0x01) {
    return { errors: ['unsupported message type (only periodic data 0x01 is decoded)'] };
  }

  // Bit-field extraction ported verbatim from the upstream periodic decoder.
  var tempCode = (parseInt(hex.substring(4, 8), 16) >> 6) & 0x3ff;
  var humCode = parseInt(hex.substring(6, 9), 16) & 0x3ff;
  var co2Code = (parseInt(hex.substring(9, 13), 16) >> 2) & 0x3fff;
  var covtCode = parseInt(hex.substring(12, 16), 16) & 0x3fff;
  var luxCode = (parseInt(hex.substring(16, 19), 16) >> 2) & 0x3ff;
  var buttonCode = (parseInt(hex.substring(18, 19), 16) >> 1) & 0x01;
  var avgNoiseCode = (parseInt(hex.substring(18, 21), 16) >> 2) & 0x7f;
  var peakNoiseCode = (parseInt(hex.substring(20, 23), 16) >> 3) & 0x7f;
  var occupancyCode = parseInt(hex.substring(22, 24), 16) & 0x7f;
  var iaqGlobalCode = (parseInt(hex.substring(24, 26), 16) >> 5) & 0x07;
  var iaqSourceCode = (parseInt(hex.substring(24, 26), 16) >> 1) & 0x0f;

  var data = {};
  var air = {};

  if (present10(tempCode)) {
    air.temperature = round(tempCode / 10 - 30, 1);
  }
  if (present10(humCode)) {
    air.relativeHumidity = round(humCode / 10, 1);
  }
  if (present14(co2Code)) {
    air.co2 = co2Code;
  }
  if (present10(luxCode)) {
    air.lightIntensity = luxCode * 5;
  }
  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.co2 !== undefined ||
    air.lightIntensity !== undefined
  ) {
    data.air = air;
  }

  // VOC total (COVT) has no vocabulary key — emit as a camelCase extra.
  if (present14(covtCode)) {
    data.tvocUgM3 = covtCode;
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

  // IziAir IAQ indices — no vocabulary key; emit human-readable labels as
  // extras, suppressing the upstream "Error" / out-of-range sentinels.
  if (iaqGlobalCode !== 7 && IAQ_GLOBAL[iaqGlobalCode] !== 'Reserved') {
    data.iaqGlobal = IAQ_GLOBAL[iaqGlobalCode];
  }
  if (iaqSourceCode !== 15 && IAQ_SOURCE[iaqSourceCode] !== 'Reserved') {
    data.iaqSource = IAQ_SOURCE[iaqSourceCode];
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "nexelec";
    result.data.model = "sign";
  }
  return result;
}
