// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec RISE (indoor 3-in-1 room sensor:
// CO2, temperature, humidity — battery- or USB-powered, NFC-configurable).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec bit-packed periodic frame: product byte, message type, then
// MSB-first bit fields) was ported from and normalized against the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nexelec/sign-codec.js, attributed in NOTICE — the RISE shares the same
// sign-codec.js as SIGN and MOVE). The upstream bit-slicing (hex-string
// substring extraction) is reproduced exactly; only the periodic data message
// (type 0x01) for the RISE product (0xAA, "Rise LoRa") is handled here.
//
// The RISE has only the CO2 / temperature / humidity sensors (per the
// datasheet); the shared frame's VOC (COVT), luminosity, button, noise,
// occupancy and IziAir bit fields belong to other products in the family and
// are not populated on a RISE, so they are not decoded here.
//
// Field mapping (periodic frame, hex-char offsets into the payload, matching the
// upstream substring/shift extraction):
//   temperature   hex[4:8]  >>6 &0x3FF  (10b) value = code/10 - 30 °C  -> air.temperature
//   humidity      hex[6:9]      &0x3FF  (10b) value = code/10 %RH      -> air.relativeHumidity
//   co2           hex[9:13] >>2 &0x3FFF (14b) value = code ppm         -> air.co2
//
// Sentinel / sensor-absent codes are honored. For the 10-bit fields (temp,
// humidity): 1021 = deactivated, 1022 = disconnected, 1023 = error. For the
// 14-bit co2 field: 16381 = deactivated, 16382 = disconnected, 16383 = error.
// At any sentinel the field is suppressed rather than emitted.

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
// 1023 (error); a 14-bit field is "absent" at 16381/16382/16383.
function present10(code) {
  return code < 1021;
}
function present14(code) {
  return code < 16381;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 12) {
    return { errors: ['payload too short for a Nexelec periodic frame'] };
  }

  var hex = bytesToHex(bytes);
  var product = parseInt(hex.substring(0, 2), 16);
  var messageType = parseInt(hex.substring(2, 4), 16);

  if (product !== 0xaa) {
    return { errors: ['unexpected product byte (expected 0xAA for Nexelec RISE)'] };
  }
  if (messageType !== 0x01) {
    return { errors: ['unsupported message type (only periodic data 0x01 is decoded)'] };
  }

  // Bit-field extraction ported verbatim from the upstream periodic decoder.
  var tempCode = (parseInt(hex.substring(4, 8), 16) >> 6) & 0x3ff;
  var humCode = parseInt(hex.substring(6, 9), 16) & 0x3ff;
  var co2Code = (parseInt(hex.substring(9, 13), 16) >> 2) & 0x3fff;

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
  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.co2 !== undefined
  ) {
    data.air = air;
  }

  return { data: data };
}
