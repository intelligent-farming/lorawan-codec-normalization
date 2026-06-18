// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for inBiot MICA Plus (Modbus-payload LoRa variant,
// "PLUS"): an indoor air-quality node reporting temperature, humidity, CO2,
// formaldehyde (CH2O), TVOC, particulate matter (PM1.0/2.5/4/10), a set of
// computed comfort/air indices, and ambient noise.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (inBiot fixed-layout sensor frame, keyed by a leading message-type
// byte and a device-type string) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/inbiot decoder.js,
// inbiot-lora-codec, attributed in NOTICE). Only the PLUS device type and the
// sensor message (leading byte 0x01) are modeled here; the unified upstream
// decoder also handles MINI/MICA/WELL/NULL types and config/info frames.
//
// Normalization choices:
//   - temperature  -> air.temperature       (raw / 10 -> degrees C)
//   - humidity     -> air.relativeHumidity  (raw / 10 -> percent)
//   - co2          -> air.co2               (ppm, vocabulary key)
//   - ch2o         -> hcho                  (ug/m3 formaldehyde; extra)
//   - tvoc         -> tvoc                  (ppb; extra)
//   - pm1.0/2.5/4/10 -> pm1_0/pm2_5/pm4/pm10 (ug/m3; extras)
//   - vIndex/tIndex/virusIndex/iaqIndex/moldIndex -> ventilationIndex /
//     thermalIndex / virusIndex / iaqIndex / moldIndex (extras)
//   - noise (dB)   -> noise                 (dBA; extra)
//   - counter      -> messageCounter        (extra)
// The device does not report battery or illuminance in the sensor frame, so
// neither `battery`/`batteryPercent` nor `air.lightIntensity` is emitted.
//
// BANNED (console-safe ES5, statically linted): require/import/export,
// module.exports, exports., process., Buffer, globalThis, eval, new Function,
// timers, console., fetch, async/await, Promise, optional chaining (?.),
// nullish (??), spread/rest (...), BigInt/123n, private #fields, static blocks.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// inBiot multi-byte fields are big-endian: (high << 8) | low.
function u16be(bytes, hi, lo) {
  return ((bytes[hi] << 8) | bytes[lo]) & 0xffff;
}

// Device type lives at bytes 27..30 (ASCII, NUL-terminated within the window).
function readType(bytes) {
  var result = '';
  var i;
  for (i = 27; i < 31; i++) {
    if (bytes[i] === 0x00 || bytes[i] === undefined) {
      break;
    }
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Only the sensor message (leading byte 0x01) carries measurements; config
  // (0x00) and device-info (0x02) frames are not modeled.
  if (bytes[0] !== 1) {
    return { errors: ['unsupported message type: only sensor message (0x01) is decoded'] };
  }

  // A full PLUS sensor frame is 38 bytes (last index used is bytes[37], noise).
  if (bytes.length < 38) {
    return { errors: ['sensor payload too short: expected 38 bytes for PLUS frame'] };
  }

  var type = readType(bytes);
  if (type !== 'PLUS') {
    return { errors: ['unsupported device type "' + type + '": this codec decodes PLUS frames only'] };
  }

  var data = {};
  var air = {};

  // Core climate + CO2 (vocabulary keys).
  air.temperature = round(u16be(bytes, 1, 2) / 10.0, 1);
  air.relativeHumidity = round(u16be(bytes, 3, 4) / 10.0, 1);
  air.co2 = u16be(bytes, 5, 6);
  data.air = air;

  // Gas + particulate extras (camelCase; no vocabulary key models these).
  data.hcho = u16be(bytes, 7, 8);
  data.tvoc = u16be(bytes, 9, 10);
  data.pm1_0 = u16be(bytes, 11, 12);
  data.pm2_5 = u16be(bytes, 13, 14);
  data.pm4 = u16be(bytes, 15, 16);
  data.pm10 = u16be(bytes, 17, 18);

  // Computed comfort / air-quality indices (extras).
  data.ventilationIndex = bytes[32];
  data.thermalIndex = bytes[33];
  data.virusIndex = bytes[34];
  data.iaqIndex = bytes[35];

  // Mold persistence index: 0xff means the device is still calculating.
  data.moldIndex = bytes[36] === 0xff ? 'Calculating' : bytes[36];

  // Ambient noise (dBA). Upstream emits this only when nonzero; 0xff is the
  // sensor preheating sentinel.
  if (bytes[37]) {
    data.noise = bytes[37] === 0xff ? 'Preheating' : bytes[37];
  }

  // Frame counter (extra).
  data.messageCounter = u16be(bytes, 25, 26);

  return { data: data };
}
