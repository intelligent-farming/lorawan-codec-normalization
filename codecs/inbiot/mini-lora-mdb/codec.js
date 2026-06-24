// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for inBiot MICA MINI Modbus - Indoor Air Quality
// Sensor (LoRaWAN). Reports temperature, humidity and CO2 plus inBiot's derived
// comfort/air indices and a noise (dB) reading.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/inbiot/decoder.js, attributed in
// NOTICE). The upstream decoder is a single dispatcher shared by the whole MICA
// family (MINI/MICA/PLUS/WELL); this codec ports the message-type dispatch and
// the MINI sensor decode faithfully, then normalizes onto the vocabulary.
//
// Message dispatch (upstream InbiotDeviceDecode, switch on bytes[0]):
//   0 = device configuration, 2 = device information. Neither carries
//       measurement data, so we report them as an unsupported-message error
//       rather than inventing data.
//   1 = sensor message. The device-type string lives at bytes[27..30]
//       (upstream customTextDecoder(bytes, 27, 31)); for this product it reads
//       "MINI". Upstream gates the sensor fields on a known type
//       (MINI/MICA/PLUS/WELL/NULL); we keep that gate.
//
// MINI sensor fields (all uint16 BIG-endian per upstream getUint16):
//   temperature = u16be(b1,b2)/10  -> air.temperature (°C)
//   humidity    = u16be(b3,b4)/10  -> air.relativeHumidity (%)
//   co2         = u16be(b5,b6)     -> air.co2 (ppm)
//   vIndex      = b32, tIndex = b33, virusIndex = b34, iaqIndex = b35
//                                  -> camelCase extras (no vocabulary key)
//   moldIndex   = b36 (0xff -> "Calculating") -> moldIndex extra
//   dB (noise)  = b37 (falsy -> omitted, 0xff -> "Preheating") -> noise extra
//   counter     = u16be(b25,b26)   -> counter extra
// The TVOC/PM/HCHO/gas fields upstream decodes for the larger MICA/PLUS/WELL
// variants are absent on MINI and are intentionally not emitted here.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, first, second) {
  return ((bytes[first] << 8) | bytes[second]) & 0xffff;
}

// Port of upstream customTextDecoder(bytes, start, end): ASCII up to the first
// NUL within [start, end).
function readText(bytes, start, end) {
  var result = '';
  for (var i = start; i < end; i++) {
    if (bytes[i] === 0x00) {
      break;
    }
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var messageType = bytes[0];
  if (messageType !== 1) {
    // 0 = configuration, 2 = device information: no measurement payload.
    return { errors: ['unsupported message type ' + messageType + ' (not a sensor message)'] };
  }

  if (bytes.length < 38) {
    return { errors: ['sensor message too short'] };
  }

  // Device type string (bytes 27..30). Upstream maps an all-NUL string to
  // "NULL" and then only decodes when the type is one of the known variants.
  var type = readText(bytes, 27, 31);
  if (type === '') {
    type = 'NULL';
  }
  var knownTypes = { MINI: true, MICA: true, PLUS: true, WELL: true, NULL: true };
  if (!knownTypes[type]) {
    return { errors: ['unrecognized device type "' + type + '"'] };
  }

  var data = {};
  var air = {};

  // TEMPERATURE: u16be / 10 °C
  air.temperature = round(u16be(bytes, 1, 2) / 10, 1);
  // HUMIDITY: u16be / 10 %
  air.relativeHumidity = round(u16be(bytes, 3, 4) / 10, 1);
  // CO2: u16be ppm
  air.co2 = u16be(bytes, 5, 6);
  data.air = air;

  // inBiot derived indices (no vocabulary key -> camelCase extras).
  data.ventilationIndex = bytes[32];
  data.thermalIndex = bytes[33];
  data.virusIndex = bytes[34];
  data.iaqIndex = bytes[35];

  // MOLD PERSISTENCE INDEX (0xff -> still calculating).
  var mold = bytes[36];
  data.moldIndex = mold === 0xff ? 'Calculating' : mold;

  // NOISE (dB). Upstream omits this when the byte is falsy (0); 0xff signals
  // the sensor is still preheating.
  if (bytes[37]) {
    data.noise = bytes[37] === 0xff ? 'Preheating' : bytes[37];
  }

  // MESSAGE COUNTER: u16be.
  data.counter = u16be(bytes, 25, 26);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "inbiot";
    result.data.model = "mini-lora-mdb";
  }
  return result;
}
