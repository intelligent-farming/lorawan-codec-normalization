// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the MClimate Fan Coil Thermostat (room ambient
// temperature and humidity, target set-point, operational mode, displayed and
// actual fan speed, valve status, and a device-status flag).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MClimate fixed 11-byte keepalive layout, keyed by the leading
// packet-type byte) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/mclimate/fan-coil-thermostat.js,
// attributed in NOTICE). Author the normalization; do NOT copy upstream.
//
// The device's room sensor temperature maps to air.temperature and humidity to
// air.relativeHumidity. The thermostat's set-point (`targetTemperature`, tenths
// of a degree C), `operationalMode`, the displayed/actual fan speeds
// (`displayedFanSpeed`, `actualFanSpeed`), `valveStatus` and `deviceStatus`
// have no vocabulary key and are emitted as camelCase extras. The fan coil
// thermostat is mains/24V powered and reports no battery reading.
//
// Non-keepalive frames are MClimate command/configuration responses that append
// an 11-byte keepalive tail. That command section is not modeled here; only the
// keepalive/periodic uplink (leading byte 0x01) carries normalized measurements.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeKeepalive(bytes, data) {
  // bytes[1..2]: room temperature, big-endian; (raw - 400) / 10 -> degrees C
  var tempRaw = (bytes[1] << 8) | bytes[2];
  data.air.temperature = round((tempRaw - 400) / 10, 2);

  // bytes[3]: humidity; raw * 100 / 256 -> percent
  data.air.relativeHumidity = round((bytes[3] * 100) / 256, 2);

  // bytes[4..5]: target set-point, big-endian; raw / 10 -> degrees C (extra)
  var targetRaw = (bytes[4] << 8) | bytes[5];
  data.targetTemperature = round(targetRaw / 10, 1);

  // bytes[6]: operational mode (extra)
  data.operationalMode = bytes[6];

  // bytes[7]: displayed fan speed (extra)
  data.displayedFanSpeed = bytes[7];

  // bytes[8]: actual fan speed (extra)
  data.actualFanSpeed = bytes[8];

  // bytes[9]: valve status (extra)
  data.valveStatus = bytes[9];

  // bytes[10]: device status flag (extra)
  data.deviceStatus = bytes[10];

  return data;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Only the keepalive/periodic uplink carries measurements. MClimate sends it
  // with leading byte 0x01. Command/configuration responses use other leading
  // bytes and append an 11-byte keepalive tail whose command section is not
  // modeled here.
  if (bytes[0] !== 1) {
    return { errors: ['unsupported packet type: only keepalive (0x01) is decoded'] };
  }

  if (bytes.length < 11) {
    return { errors: ['keepalive payload too short: expected 11 bytes'] };
  }

  var data = { air: {} };
  decodeKeepalive(bytes, data);
  return { data: data };
}
