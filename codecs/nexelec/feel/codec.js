// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec FEEL (indoor 2-in-1 room sensor:
// temperature + humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec bit-packed periodic frame: product byte, message type, then
// MSB-first bit fields) was ported from and normalized against the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nexelec/sign-codec.js, attributed in NOTICE). The upstream bit-slicing
// (hex-string substring extraction) is reproduced exactly; only the periodic
// data message (type 0x01) for the FEEL product (0xA9, "Feel LoRa") is handled
// here.
//
// The FEEL shares the Nexelec frame format with its SIGN/MOVE siblings, but per
// its datasheet (a "2-in-1" temperature + humidity room sensor) it only carries
// the temperature and humidity sensors. The CO2 (co2/covt), luminosity, noise,
// occupancy and IziAir IAQ bit fields physically exist in the shared frame but
// are not real sensors on the FEEL — upstream reports them as sentinel
// ("Error"/"Deconnected sensor") values — so they are deliberately not decoded
// here. The button-press flag is decoded as a camelCase extra.
//
// Field mapping (periodic frame, hex-char offsets into the payload, matching the
// upstream substring/shift extraction):
//   temperature   hex[4:8]  >>6 &0x3FF  (10b) value = code/10 - 30 °C -> air.temperature
//   humidity      hex[6:9]      &0x3FF  (10b) value = code/10 %RH     -> air.relativeHumidity
//   buttonPress   hex[18:19]>>1 &0x01   ( 1b)                         -> buttonPressed (extra)
//
// Sentinel / sensor-absent codes are honored. For the 10-bit fields (temp,
// humidity): 1021 = deactivated, 1022 = disconnected, 1023 = error. At any
// sentinel the field is suppressed rather than emitted.

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
// 1023 (error).
function present10(code) {
  return code < 1021;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 12) {
    return { errors: ['payload too short for a Nexelec periodic frame'] };
  }

  var hex = bytesToHex(bytes);
  var product = parseInt(hex.substring(0, 2), 16);
  var messageType = parseInt(hex.substring(2, 4), 16);

  if (product !== 0xa9) {
    return { errors: ['unexpected product byte (expected 0xA9 for Nexelec FEEL)'] };
  }
  if (messageType !== 0x01) {
    return { errors: ['unsupported message type (only periodic data 0x01 is decoded)'] };
  }

  // Bit-field extraction ported verbatim from the upstream periodic decoder.
  var tempCode = (parseInt(hex.substring(4, 8), 16) >> 6) & 0x3ff;
  var humCode = parseInt(hex.substring(6, 9), 16) & 0x3ff;
  var buttonCode = (parseInt(hex.substring(18, 19), 16) >> 1) & 0x01;

  var data = {};
  var air = {};

  if (present10(tempCode)) {
    air.temperature = round(tempCode / 10 - 30, 1);
  }
  if (present10(humCode)) {
    air.relativeHumidity = round(humCode / 10, 1);
  }
  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }

  data.buttonPressed = buttonCode === 1;

  return { data: data };
}
