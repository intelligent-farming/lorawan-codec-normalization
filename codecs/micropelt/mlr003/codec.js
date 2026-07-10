// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Micropelt MLR003 (LoRaWAN TRV — energy-
// harvesting thermostatic radiator valve actuator).
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/micropelt/mlr003.js, attributed in
// NOTICE). Normalization authored here; upstream Decode() output is NOT copied.
//
// Only fPort 1 (Basic Device Data) carries actuation + measurement telemetry.
// fPort 1 layout (per upstream decode_port_1):
//   bytes[0]  current valve position, 0-100 %      -> hvac.valvePosition (%)
//   bytes[4]  ambient temperature, 0.25 °C/count   -> air.temperature (°C)
//   bytes[6]  storage voltage, 0.02 V/count        -> battery (V)
//   bytes[9]  bits 0..2 = user (operating) mode     -> hvac.mode + setpoint gate
//   bytes[10] user value, scaled per user mode      -> hvac.setpoint when the
//             mode is a temperature setpoint (SP_Ambient_Temperature: 0.5 °C)
// The TRV always reports a valve position, so hvac.valvePosition satisfies the
// thermostat atLeastOne; hvac.setpoint is added when the mode is a temperature
// target. Config/version/parameter ports (2,3,4,5,6,7,9,15) carry no telemetry.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function userModeName(code) {
  switch (code) {
    case 0: return 'Valve_Position';
    case 1: return 'RESERVED';
    case 2: return 'SP_Ambient_Temperature';
    case 3: return 'Detecting_Opening_Point';
    case 4: return 'Slow_Harvesting';
    case 5: return 'Temperature_Drop';
    case 6: return 'Freeze_Protect';
    case 7: return 'Forced_Heating';
    default: return 'Unknown';
  }
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 1, Basic Device Data)'] };
  }
  if (!bytes || bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data = {};
  var hvac = {};

  // Valve position (byte 0), always present -> satisfies thermostat atLeastOne.
  hvac.valvePosition = bytes[0];

  // Operating mode (byte 9, low 3 bits) reported as hvac.mode.
  var modeCode = bytes[9] & 0x07;
  hvac.mode = userModeName(modeCode);

  // Setpoint derives from the user value (byte 10), scaled per mode. Only the
  // ambient-temperature mode yields a °C setpoint (0.5 °C/count).
  if (modeCode === 2) {
    hvac.setpoint = round(bytes[10] * 0.5, 1);
  }

  data.hvac = hvac;

  // Measured room temperature (byte 4), 0.25 °C/count.
  data.air = { temperature: round(bytes[4] * 0.25, 2) };

  // Storage (harvesting) voltage (byte 6), 0.02 V/count.
  data.battery = round(bytes[6] * 0.02, 2);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "micropelt";
    result.data.model = "mlr003";
  }
  return result;
}
