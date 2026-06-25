// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for espeasy/espeasy-rn2903-node-class-a-abp
// (ESPEasy RN2903 Class A OTAA development board, "PACKED" payload encoder).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/espeasy/packed-decode-uplink.js,
// attributed in NOTICE). Do NOT copy upstream normalizeUplink.
//
// Ported from the upstream decodeUplink: on fPort 1 every frame begins with a
// 5-byte header (byte0 = ESPEasy plugin_id, bytes1-2 = task IDX (LE u16),
// byte3 = samplesetcount, byte4 = valuecount). Following the header are
// `valuecount` signed 32-bit little-endian values, each scaled by 1e-4
// (upstream int32_1e4). The plugin_id selects which sensor produced the frame
// and what its values mean.
//
// This is a generic multi-sensor node. For the air-quality category we decode
// the CO2-reporting plugins (SenseAir id 52, MHZ19 id 49, CCS811 id 90) to the
// vocabulary key air.co2 (ppm); any companion temperature / TVOC value is
// carried as a camelCase extra. Frames from non-CO2 plugins carry no calibrated
// air-quality vocabulary value and are rejected with an error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Signed 32-bit little-endian integer from 4 bytes at offset.
function readInt32LE(bytes, offset) {
  var v = (bytes[offset]) +
    (bytes[offset + 1] * 256) +
    (bytes[offset + 2] * 65536) +
    (bytes[offset + 3] * 16777216);
  if (v > 2147483647) {
    v -= 4294967296;
  }
  return v;
}

// Upstream packs each value as int32 scaled by 1e4 (lora-serialization int32_1e4).
function readValue1e4(bytes, offset) {
  return round(readInt32LE(bytes, offset) / 10000, 4);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ': PACKED uplinks use fPort 1'] };
  }
  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short: expected at least a 5-byte header'] };
  }

  var pluginId = bytes[0];
  var valueCount = bytes[4];

  // values start after the 5-byte header; each is 4 bytes.
  if (bytes.length < 5 + valueCount * 4) {
    return { errors: ['payload too short: header declares ' + valueCount + ' value(s) but bytes are missing'] };
  }

  function valueAt(i) {
    return readValue1e4(bytes, 5 + i * 4);
  }

  var data = {};
  var co2;

  if (pluginId === 52) {
    // SenseAir S8 — val_1 = CO2 ppm, optional val_2 = temperature (degC).
    if (valueCount < 1) {
      return { errors: ['SenseAir frame declares no values'] };
    }
    co2 = valueAt(0);
    data.air = { co2: co2 };
    if (valueCount >= 2) {
      data.sensorTemperature = valueAt(1);
    }
    return { data: data };
  }

  if (pluginId === 49) {
    // MHZ19 — val_1 = CO2 ppm, val_2 = temperature, val_3 = sensor U value.
    if (valueCount < 1) {
      return { errors: ['MHZ19 frame declares no values'] };
    }
    co2 = valueAt(0);
    data.air = { co2: co2 };
    if (valueCount >= 2) {
      data.sensorTemperature = valueAt(1);
    }
    if (valueCount >= 3) {
      data.mhz19U = valueAt(2);
    }
    return { data: data };
  }

  if (pluginId === 90) {
    // CCS811 — val_1 = TVOC, val_2 = eCO2 (equivalent CO2 ppm).
    if (valueCount < 2) {
      return { errors: ['CCS811 frame is missing the eCO2 value'] };
    }
    data.tvoc = valueAt(0);
    co2 = valueAt(1);
    data.air = { co2: co2 };
    return { data: data };
  }

  return {
    errors: ['ESPEasy plugin_id ' + pluginId + ' reports no air-quality (CO2) value']
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "espeasy";
    result.data.model = "espeasy-rn2903-node-class-a-abp";
  }
  return result;
}
