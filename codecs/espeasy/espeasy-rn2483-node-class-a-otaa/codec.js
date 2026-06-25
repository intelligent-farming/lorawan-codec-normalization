// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for espeasy/espeasy-rn2483-node-class-a-otaa.
//
// Wire format ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/espeasy/packed-decode-uplink.js,
// based on thesolarnomad/lora-serialization; attributed in NOTICE).
// The "PACKED" encoder frames uplinks on fPort 1 as a 5-byte header
// (plugin_id, IDX, samplesetcount, valuecount) followed by up to four
// signed 32-bit little-endian values scaled by 1e4 (int32_1e4).
// The ESPEasy CO2 plugins (P049 MHZ19, P052 SenseAir) place the CO2
// concentration (ppm) in the first value, which we normalize to air.co2.
// Normalization is authored here; upstream normalizeUplink is NOT copied.

// Round to a fixed number of decimal places.
function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Little-endian unsigned integer from a byte slice.
function bytesToUint(bytes, offset, len) {
  var i = 0;
  for (var x = 0; x < len; x++) {
    i += (bytes[offset + x] & 0xff) * Math.pow(2, 8 * x);
  }
  return i;
}

// Signed 32-bit little-endian value scaled by 1e4 (int32_1e4 in upstream).
function int32_1e4(bytes, offset) {
  var v = bytesToUint(bytes, offset, 4);
  if (v > 2147483647) {
    v -= 4294967296;
  }
  return round(v / 1e4, 4);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  if (fPort !== 1) {
    return { errors: ['unsupported fPort: ' + fPort] };
  }
  if (bytes.length < 9) {
    return { errors: ['payload too short for ESPEasy PACKED header + value'] };
  }

  // 5-byte header: plugin_id(1), IDX(2), samplesetcount(1), valuecount(1).
  var pluginId = bytes[0] & 0xff;
  var idx = bytesToUint(bytes, 1, 2);
  var sampleSetCount = bytes[3] & 0xff;
  var valueCount = bytes[4] & 0xff;

  // Only the CO2 plugins are normalized to the air-quality vocabulary.
  // P049 MHZ19: val_1=ppm, val_2=temperature(degC). P052 SenseAir: val_1=ppm, val_2=temperature(degC).
  if (pluginId !== 49 && pluginId !== 52) {
    return { errors: ['unsupported ESPEasy plugin for air-quality normalization: plugin_id ' + pluginId] };
  }

  // Read available int32_1e4 values after the 5-byte header.
  var available = Math.floor((bytes.length - 5) / 4);
  if (available < 1) {
    return { errors: ['payload missing CO2 value'] };
  }

  var ppm = int32_1e4(bytes, 5);
  if (ppm < 0 || ppm > 1000000) {
    return { errors: ['CO2 ppm out of range: ' + ppm] };
  }

  var data = {
    air: { co2: ppm },
    plugin: pluginId === 49 ? 'MHZ19' : 'SenseAir',
    deviceIdx: idx,
    sampleSetCount: sampleSetCount,
    valueCount: valueCount
  };

  // Second value is temperature (degC) for both CO2 plugins, when present.
  if (available >= 2) {
    var temp = int32_1e4(bytes, 9);
    if (temp >= -273.15) {
      data.air.temperature = temp;
    }
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "espeasy";
    result.data.model = "espeasy-rn2483-node-class-a-otaa";
  }
  return result;
}
