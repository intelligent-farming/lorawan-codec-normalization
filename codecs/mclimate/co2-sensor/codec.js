// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MClimate CO2 Sensor and Notifier (CO2,
// temperature, humidity node).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MClimate fixed 7-byte keepalive layout, keyed by the leading
// packet-type byte) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/mclimate/co2-sensor.js,
// attributed in NOTICE). Ported from that upstream decodeUplink; do NOT copy
// upstream normalizeUplink.
//
// MClimate reports battery as a millivolt-derived VOLTAGE
// ((raw * 8 + 1600) / 1000 V), so it maps directly to the vocabulary
// `battery` key. The device's own `sensorTemperature` maps to air.temperature
// and `CO2` maps to air.co2 (ppm).
//
// Note: the upstream keepalive decoder rebuilds the frame from a hex string
// (bytes[1..2] CO2, bytes[3..4] temperature, bytes[5] humidity, bytes[6]
// battery). This codec uses correct big-endian byte math directly. The
// configuration-response frame (leading byte != 0x01), which appends a 7-byte
// keepalive tail after a variable command section, is not modeled here.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeKeepalive(bytes, data) {
  // bytes[1..2]: CO2 in ppm, big-endian
  data.air.co2 = (bytes[1] << 8) | bytes[2];

  // bytes[3..4]: temperature, big-endian; (raw - 400) / 10 -> degrees C
  var tempRaw = (bytes[3] << 8) | bytes[4];
  data.air.temperature = round((tempRaw - 400) / 10, 1);

  // bytes[5]: humidity; raw * 100 / 256 -> percent
  data.air.relativeHumidity = round((bytes[5] * 100) / 256, 2);

  // bytes[6]: battery; (raw * 8 + 1600) millivolts -> volts
  data.battery = round((bytes[6] * 8 + 1600) / 1000, 2);

  return data;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Only the keepalive/periodic uplink (leading byte 0x01) carries
  // measurements. Configuration-response frames append a 7-byte keepalive
  // tail, but their command section is not modeled here.
  if (bytes[0] !== 1) {
    return { errors: ['unsupported packet type: only keepalive (0x01) is decoded'] };
  }

  if (bytes.length < 7) {
    return { errors: ['keepalive payload too short: expected 7 bytes'] };
  }

  var data = { air: {} };
  decodeKeepalive(bytes, data);
  return { data: data };
}
