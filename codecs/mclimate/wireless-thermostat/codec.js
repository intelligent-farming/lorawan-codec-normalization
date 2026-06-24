// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the MClimate Wireless Thermostat (ambient
// temperature, humidity, battery, target-temperature display, power-source
// status, ambient light, and PIR occupancy).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MClimate fixed 11-byte keepalive layout, keyed by the leading
// packet-type byte) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/mclimate/wireless-thermostat.js,
// attributed in NOTICE).
//
// MClimate reports battery as a VOLTAGE (raw / 1000 V), so it maps directly to
// the vocabulary `battery` key. The device's own sensor temperature maps to
// air.temperature and humidity to air.relativeHumidity. Ambient light is lux,
// mapping to air.lightIntensity. PIR occupancy maps to action.motion.detected.
// The thermostat's set-point (`targetTemperature`, integer degrees C) and the
// `powerSourceStatus` flag have no vocabulary key and are emitted as camelCase
// extras.
//
// Note: the upstream decoder builds multi-byte values by string-concatenating
// `byte.toString(16)` without per-byte zero padding (e.g.
// `'0' + bytes[1].toString(16) + bytes[2].toString(16)`), which silently
// corrupts any reading whose low byte is < 0x10. This codec uses correct byte
// math.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeKeepalive(bytes, data) {
  // bytes[1..2]: temperature, big-endian; (raw - 400) / 10 -> degrees C
  var tempRaw = (bytes[1] << 8) | bytes[2];
  data.air.temperature = round((tempRaw - 400) / 10, 2);

  // bytes[3]: humidity; raw * 100 / 256 -> percent
  data.air.relativeHumidity = round((bytes[3] * 100) / 256, 2);

  // bytes[4..5]: battery voltage in millivolts, big-endian -> volts
  var battRaw = (bytes[4] << 8) | bytes[5];
  data.battery = round(battRaw / 1000, 3);

  // bytes[6]: thermostat display set-point, integer degrees C (extra)
  data.targetTemperature = bytes[6];

  // bytes[7]: power source status flag (extra)
  data.powerSourceStatus = bytes[7];

  // bytes[8..9]: ambient light in lux, big-endian
  data.air.lightIntensity = (bytes[8] << 8) | bytes[9];

  // bytes[10]: PIR occupancy flag
  data.action = { motion: { detected: bytes[10] === 1 } };

  return data;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Only the keepalive/periodic uplink carries measurements. MClimate sends it
  // with leading byte 0x01 (and 0x81 for the explicit-request variant); both
  // share the same 11-byte fixed layout. Configuration-response frames append
  // an 11-byte keepalive tail, but their command section is not modeled here.
  if (bytes[0] !== 1 && bytes[0] !== 129) {
    return { errors: ['unsupported packet type: only keepalive (0x01/0x81) is decoded'] };
  }

  if (bytes.length < 11) {
    return { errors: ['keepalive payload too short: expected 11 bytes'] };
  }

  var data = { air: {} };
  decodeKeepalive(bytes, data);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mclimate";
    result.data.model = "wireless-thermostat";
  }
  return result;
}
