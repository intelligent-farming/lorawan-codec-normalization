// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for espeasy/espeasy-rn2483-node-class-a-abp — an
// ESPEasy LoRaWAN node (Microchip RN2483) running the generic "PACKED"
// controller (C018). It can host >100 ESPEasy plugins; this codec normalizes
// the air-quality-relevant ones.
//
// Wire format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/espeasy/packed-decode-uplink.js,
// attributed in NOTICE). The PACKED frame on fPort 1 is:
//   byte 0      plugin_id (uint8)            - selects the ESPEasy plugin
//   bytes 1..2  IDX (uint16, little-endian)  - controller task index
//   byte 3      samplesetcount (uint8)
//   byte 4      valuecount (uint8)
//   then `valuecount` little-endian int32 values, each scaled by 1e-4.
// The upstream "Converter" assigns plugin-specific names (ppm, temp, hum, ...)
// to those values. We re-derive the frame directly and map only the
// air-quality plugins onto vocabulary keys; we do NOT copy upstream
// normalizeUplink (upstream emits raw `name`/`bytes`/`port` debug fields and a
// flat multi-value object).
//
// Mappings (ppm = parts-per-million CO2, already calibrated by the sensor):
//   49 MHZ19     -> air.co2 (val_1 ppm), air.temperature (val_2)
//   52 SenseAir  -> air.co2 (val_1 ppm), air.temperature (val_2 if present)
//   53 PMSx003   -> air.pm1_0, air.pm2_5, air.pm10 (ug/m3)
//   56 SDS011    -> air.pm2_5, air.pm10 (ug/m3)
//   28 BME280    -> air.temperature, air.relativeHumidity, air.pressure (hPa)
//  106 BME680    -> air.temperature, air.relativeHumidity, air.pressure, gasResistance (extra)
//    5 DHT / 14 SI7021 / 34 DHT12 / 51 AM2320 / 68 SHT3x / 72 HDC1080
//               -> air.temperature, air.relativeHumidity
// Non-air plugins (SysInfo diagnostics, GPS, energy meters, etc.) carry no
// air vocabulary key and return an error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Little-endian unsigned assembly of `len` bytes starting at `off`.
function leUint(bytes, off, len) {
  var v = 0;
  var mul = 1;
  for (var k = 0; k < len; k++) {
    v += bytes[off + k] * mul;
    mul *= 256;
  }
  return v;
}

// Signed 32-bit little-endian, scaled by 1e-4 — the PACKED value encoding.
function val1e4(bytes, off) {
  var v = leUint(bytes, off, 4);
  if (v > 2147483647) {
    v -= 4294967296;
  }
  return v / 1e4;
}

function parseHeader(bytes) {
  return {
    pluginId: bytes[0],
    idx: leUint(bytes, 1, 2),
    sampleSetCount: bytes[3],
    valueCount: bytes[4]
  };
}

// Decode `count` PACKED values from `bytes` starting after the 5-byte header.
// A value beyond the present bytes is treated as absent (null).
function readValues(bytes, count) {
  var out = [];
  var off = 5;
  for (var k = 0; k < count; k++) {
    if (off + 4 > bytes.length) {
      out.push(null);
    } else {
      out.push(val1e4(bytes, off));
    }
    off += 4;
  }
  return out;
}

function present(x) {
  return x !== null && x !== undefined;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (PACKED uses fPort 1)'] };
  }
  if (bytes.length < 5) {
    return { errors: ['truncated PACKED header (need 5 bytes, got ' + bytes.length + ')'] };
  }

  var h = parseHeader(bytes);
  var pid = h.pluginId;
  var v = readValues(bytes, h.valueCount);

  var air = {};
  var data = {};

  if (pid === 49 || pid === 52) {
    // MHZ19 / SenseAir: val_1 = CO2 ppm, val_2 = temperature (optional).
    if (present(v[0])) {
      air.co2 = round(v[0], 4);
    }
    if (present(v[1])) {
      air.temperature = round(v[1], 2);
    }
  } else if (pid === 53) {
    // PMSx003: pm1_0, pm2_5, pm10.
    if (present(v[0])) {
      air.pm1_0 = round(v[0], 4);
    }
    if (present(v[1])) {
      air.pm2_5 = round(v[1], 4);
    }
    if (present(v[2])) {
      air.pm10 = round(v[2], 4);
    }
  } else if (pid === 56) {
    // SDS011: pm2_5, pm10.
    if (present(v[0])) {
      air.pm2_5 = round(v[0], 4);
    }
    if (present(v[1])) {
      air.pm10 = round(v[1], 4);
    }
  } else if (pid === 28 || pid === 106) {
    // BME280 / BME680: temp, hum, pressure (hPa) [, gas].
    if (present(v[0])) {
      air.temperature = round(v[0], 2);
    }
    if (present(v[1])) {
      air.relativeHumidity = round(v[1], 2);
    }
    if (present(v[2])) {
      air.pressure = round(v[2], 2);
    }
    if (pid === 106 && present(v[3])) {
      // BME680 gas resistance has no vocabulary key — camelCase extra.
      data.gasResistance = round(v[3], 4);
    }
  } else if (pid === 5 || pid === 14 || pid === 34 || pid === 51 || pid === 68 || pid === 72) {
    // DHT / SI7021 / DHT12 / AM2320 / SHT3x / HDC1080: temp, hum.
    if (present(v[0])) {
      air.temperature = round(v[0], 2);
    }
    if (present(v[1])) {
      air.relativeHumidity = round(v[1], 2);
    }
  } else {
    return {
      errors: ['ESPEasy plugin ' + pid + ' has no air-quality measurement']
    };
  }

  var hasAir = false;
  var prop;
  for (prop in air) {
    if (Object.prototype.hasOwnProperty.call(air, prop)) {
      hasAir = true;
      break;
    }
  }
  if (!hasAir && data.gasResistance === undefined) {
    return { errors: ['no usable air measurement in plugin ' + pid + ' frame'] };
  }
  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "espeasy";
    result.data.model = "espeasy-rn2483-node-class-a-abp";
  }
  return result;
}
