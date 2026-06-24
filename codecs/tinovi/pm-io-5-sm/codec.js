// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Tinovi PM-IO-5-SM
// (LoRaWAN soil moisture / temperature / EC probe with optional air
// temperature+humidity+pressure, light, pulse, second soil probe, an analog
// pressure channel and a leaf-wetness sensor; plus a latching-valve output and
// a leak input).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tinovi/pm-io-5-sm.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// Wire layout, ported faithfully from the upstream decoder. byte[0] is a flag
// bitmask, byte[1] is the battery percentage, then variable-length sensor
// blocks follow in the upstream's fixed decode order (note: the PULSE block,
// flag bit 4, is decoded BEFORE the second-soil block, flag bit 3, so its bytes
// come first on the wire):
//   byte[0] bit 7  valve output state            -> valveOpen (extra, bool)
//   byte[0] bit 6  leak input state              -> water.leak (bool)
//   byte[0] bit 0  SOIL block present (8 bytes)
//   byte[0] bit 1  BME (air) block present (6 bytes)
//   byte[0] bit 2  OPT (light) block present (4 bytes)
//   byte[0] bit 4  PULSE block present (4 bytes)
//   byte[0] bit 3  second SOIL block present (8 bytes)
//   byte[0] bit 5  PRESSURE block present (2 bytes)
//   trailing       optional set1 byte + LEAF block (bit 1 of set1, 4 bytes)
//   byte[1]        battery, percent             -> batteryPercent (extra)
//
// SOIL block (8 bytes, big-endian unsigned unless noted):
//   e25  uint16 /100  dielectric permittivity at 25C  -> soilE25 (extra)
//   ec   uint16 /10   soil EC in uS/cm                 -> soil.ec (dS/m, /1000)
//   temp int16  /100  soil temperature (signed) C      -> soil.temperature
//   vwc  uint16 /1    soil volumetric water content %  -> soil.moisture
// The upstream Tinovi I2C library divides VWC by 10, but this LoRaWAN firmware
// transmits it pre-scaled (divisor 1); the TTN decoder is the wire-format source
// of truth, so VWC is ported as raw/1.
//
// BME block (6 bytes): airTemp int16 /100 C -> air.temperature; airHum uint16
// /100 % -> air.relativeHumidity; airPres uint16 + 50000 Pa -> air.pressure
// (hPa, /100). Upstream suppresses pressure when raw == 15536 (== 65536 Pa), a
// sentinel for "no reading"; that suppression is preserved.
//
// OPT block (4 bytes): lux uint32 /100 -> air.lightIntensity (lux).
// PULSE block (4 bytes): pulse uint32 /1 -> pulseCount (extra).
// Second SOIL block (8 bytes): mapped to soil1* extras (the vocabulary models a
// single soil probe; the second probe's channels are vendor extras).
// PRESSURE block (2 bytes): press uint16 /100 -> pressureChannel (extra); this
// is a raw analog channel, distinct from atmospheric air.pressure.
// LEAF block (4 bytes): leafHum uint16 /100 -> leafHumidity (extra);
// leafTemp int16 /100 -> leafTemperature (extra).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer over the byte slice, divided by dev.
function bytesToInt(byteArray, dev) {
  var value = 0;
  for (var i = 0; i < byteArray.length; i++) {
    value = value * 256 + byteArray[i];
  }
  return value / dev;
}

// 16-bit signed (two's complement) integer over a 2-byte slice, divided by dev.
function bytesToSignedInt(b, dev) {
  var x = ((b[0] & 0xff) << 8) | (b[1] & 0xff);
  if (b[0] & 0x80) {
    x = x - 0x10000;
  }
  return x / dev;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return {
      errors: ['expected at least 2 bytes, got ' + (bytes ? bytes.length : 0)]
    };
  }

  var flags = bytes[0];
  var pos = 1;

  var data = {};
  var soil = {};
  var air = {};

  // byte[0] high flags: valve output and leak input states.
  data.valveOpen = ((flags >> 7) & 1) === 1;
  var water = { leak: ((flags >> 6) & 1) === 1 };

  // byte[1]: battery percentage (NOT volts -> batteryPercent extra).
  data.batteryPercent = bytes[pos];
  pos = pos + 1;

  // bit 0: primary SOIL block (8 bytes).
  if ((flags & 1) === 1) {
    if (bytes.length < pos + 8) {
      return { errors: ['truncated SOIL block'] };
    }
    // e25: dielectric permittivity at 25C; vendor diagnostic, not vocabulary.
    data.soilE25 = round(bytesToInt(bytes.slice(pos, pos + 2), 100), 2);
    pos = pos + 2;
    // ec: uS/cm on the wire -> dS/m (/1000) for soil.ec.
    soil.ec = round(bytesToInt(bytes.slice(pos, pos + 2), 10) / 1000, 4);
    pos = pos + 2;
    soil.temperature = round(bytesToSignedInt(bytes.slice(pos, pos + 2), 100), 2);
    pos = pos + 2;
    soil.moisture = round(bytesToInt(bytes.slice(pos, pos + 2), 1), 1);
    pos = pos + 2;
  }

  // bit 1: BME air block (6 bytes).
  if (((flags >> 1) & 1) === 1) {
    if (bytes.length < pos + 6) {
      return { errors: ['truncated BME block'] };
    }
    air.temperature = round(bytesToSignedInt(bytes.slice(pos, pos + 2), 100), 2);
    pos = pos + 2;
    air.relativeHumidity = round(bytesToInt(bytes.slice(pos, pos + 2), 100), 2);
    pos = pos + 2;
    var airPresPa = bytesToInt(bytes.slice(pos, pos + 2), 1) + 50000;
    // Upstream sentinel: raw 15536 (== 65536 Pa) means "no reading".
    if (airPresPa !== 65536) {
      air.pressure = round(airPresPa / 100, 2);
    }
    pos = pos + 2;
  }

  // bit 2: OPT light block (4 bytes).
  if (((flags >> 2) & 1) === 1) {
    if (bytes.length < pos + 4) {
      return { errors: ['truncated OPT block'] };
    }
    air.lightIntensity = round(bytesToInt(bytes.slice(pos, pos + 4), 100), 2);
    pos = pos + 4;
  }

  // bit 4: PULSE block (4 bytes). Decoded before the second SOIL block,
  // matching the upstream wire order.
  if (((flags >> 4) & 1) === 1) {
    if (bytes.length < pos + 4) {
      return { errors: ['truncated PULSE block'] };
    }
    data.pulseCount = bytesToInt(bytes.slice(pos, pos + 4), 1);
    pos = pos + 4;
  }

  // bit 3: second SOIL block (8 bytes) -> soil1* extras.
  if (((flags >> 3) & 1) === 1) {
    if (bytes.length < pos + 8) {
      return { errors: ['truncated second SOIL block'] };
    }
    data.soil1E25 = round(bytesToInt(bytes.slice(pos, pos + 2), 100), 2);
    pos = pos + 2;
    data.soil1Ec = round(bytesToInt(bytes.slice(pos, pos + 2), 10) / 1000, 4);
    pos = pos + 2;
    data.soil1Temperature = round(bytesToSignedInt(bytes.slice(pos, pos + 2), 100), 2);
    pos = pos + 2;
    data.soil1Moisture = round(bytesToInt(bytes.slice(pos, pos + 2), 1), 1);
    pos = pos + 2;
  }

  // bit 5: PRESSURE analog channel (2 bytes) -> pressureChannel extra.
  if (((flags >> 5) & 1) === 1) {
    if (bytes.length < pos + 2) {
      return { errors: ['truncated PRESSURE block'] };
    }
    data.pressureChannel = round(bytesToInt(bytes.slice(pos, pos + 2), 100), 2);
    pos = pos + 2;
  }

  // Trailing optional LEAF block, gated on a set1 byte (upstream guards on
  // bytes.length > pos + 1) whose bit 1 enables the leaf sensor.
  if (bytes.length > pos + 1) {
    var set1 = bytes[pos];
    pos = pos + 1;
    if (((set1 >> 1) & 1) === 1) {
      if (bytes.length < pos + 4) {
        return { errors: ['truncated LEAF block'] };
      }
      data.leafHumidity = round(bytesToInt(bytes.slice(pos, pos + 2), 100), 2);
      pos = pos + 2;
      data.leafTemperature = round(bytesToSignedInt(bytes.slice(pos, pos + 2), 100), 2);
      pos = pos + 2;
    }
  }

  // Attach grouped objects only when populated.
  if (soil.ec !== undefined || soil.temperature !== undefined ||
      soil.moisture !== undefined) {
    data.soil = soil;
  }
  if (air.temperature !== undefined || air.relativeHumidity !== undefined ||
      air.pressure !== undefined || air.lightIntensity !== undefined) {
    data.air = air;
  }
  data.water = water;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tinovi";
    result.data.model = "pm-io-5-sm";
  }
  return result;
}
