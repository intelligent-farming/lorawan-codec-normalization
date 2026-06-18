// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the MClimate Vicki smart radiator thermostat
// (TRV): room/sensor temperature, relative humidity, set-point, motor
// position/range, valve openness, battery voltage and operational status flags.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MClimate fixed 9-byte keepalive layout, keyed by the leading
// reason byte) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/vicki.js, attributed in
// NOTICE).
//
// The measurement-bearing frame is the 9-byte keepalive. The device sends it
// directly with leading reason byte 0x01 (periodic) or 0x81 (explicit request);
// configuration-response frames prepend a command section and append the same
// 9-byte keepalive tail. This codec decodes the keepalive (taking the trailing
// 9 bytes when a command section is present) and does NOT model the config
// command parser, which carries no normalized measurement.
//
// Mappings: the device's sensor temperature -> air.temperature and humidity ->
// air.relativeHumidity. MClimate reports battery as a VOLTAGE (2 + n*0.1 V from
// the high nibble of byte 7), so it maps directly to the vocabulary `battery`
// key. The TRV-specific readings (set-point `targetTemperature`, `motorRange`,
// `motorPosition`, `valveOpenness`, the `reason` code) and the operational
// status flags have no vocabulary key and are emitted as camelCase extras.
//
// Note: the upstream decoder reads the battery/status nibbles via
// `byte.toString(16)` string slicing and computes valveOpenness from the motor
// position/range; this codec reproduces the same arithmetic with plain byte/bit
// math (no string-hex parsing).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bit(value, index) {
  // index counts from the most-significant bit of an 8-bit value (bit 0 = MSB),
  // matching the upstream `decbin` 8-char binary-string indexing.
  return (value >> (7 - index)) & 1;
}

function decodeKeepalive(bytes) {
  var data = { air: {} };

  var reason = bytes[0];

  // bytes[1]: target temperature, integer degrees C (also the float set-point).
  data.targetTemperature = bytes[1];
  data.targetTemperatureFloat = bytes[1];

  // bytes[2]: sensor temperature. The transfer function depends on the reason
  // code: 0x01 (periodic) uses the linear ADC mapping; 0x81 (explicit request)
  // uses the device's pre-scaled value.
  var sensorTemp;
  if (reason === 0x81) {
    sensorTemp = (bytes[2] - 28.33333) / 5.66666;
  } else {
    sensorTemp = (bytes[2] * 165) / 256 - 40;
  }
  data.air.temperature = round(sensorTemp, 2);

  // bytes[3]: relative humidity -> percent.
  data.air.relativeHumidity = round((bytes[3] * 100) / 256, 2);

  // Motor position and range are 12-bit values split across nibbles of byte 6:
  // high nibble -> motor position high nibble, low nibble -> motor range high
  // nibble; bytes[4]/bytes[5] are the respective low bytes.
  var motorPosHi = (bytes[6] >> 4) & 0x0f;
  var motorRangeHi = bytes[6] & 0x0f;
  var motorPosition = (motorPosHi << 8) | bytes[4];
  var motorRange = (motorRangeHi << 8) | bytes[5];
  data.motorPosition = motorPosition;
  data.motorRange = motorRange;
  data.valveOpenness = motorRange !== 0
    ? Math.round((1 - (motorPosition / motorRange)) * 100)
    : 0;

  // bytes[7]: high nibble encodes battery voltage (2 + n*0.1 V); low bits carry
  // motor/sensor status flags.
  var battNibble = (bytes[7] >> 4) & 0x0f;
  data.battery = round(2 + battNibble * 0.1, 2);
  data.openWindow = bit(bytes[7], 4) === 1;
  data.highMotorConsumption = bit(bytes[7], 5) === 1;
  data.lowMotorConsumption = bit(bytes[7], 6) === 1;
  data.brokenSensor = bit(bytes[7], 7) === 1;

  // bytes[8]: further operational status flags.
  data.childLock = bit(bytes[8], 0) === 1;
  data.calibrationFailed = bit(bytes[8], 1) === 1;
  data.attachedBackplate = bit(bytes[8], 2) === 1;
  data.perceiveAsOnline = bit(bytes[8], 3) === 1;
  data.antiFreezeProtection = bit(bytes[8], 4) === 1;

  data.reason = reason;

  return data;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // The keepalive is a fixed 9-byte frame. Periodic (0x01) and explicit-request
  // (0x81) uplinks ARE the keepalive; configuration-response frames prepend a
  // command section and carry the keepalive as the trailing 9 bytes.
  var keepalive;
  if (bytes[0] === 0x01 || bytes[0] === 0x81) {
    if (bytes.length < 9) {
      return { errors: ['keepalive payload too short: expected 9 bytes'] };
    }
    keepalive = bytes;
  } else {
    if (bytes.length < 9) {
      return { errors: ['payload too short: expected at least a 9-byte keepalive tail'] };
    }
    keepalive = bytes.slice(bytes.length - 9);
  }

  return { data: decodeKeepalive(keepalive) };
}
