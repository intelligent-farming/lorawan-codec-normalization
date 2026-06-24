// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Micropelt MLR-TPS1 (energy-harvesting radiator
// thermostat with built-in PIR occupancy sensor, ambient temperature sensor,
// and a manual set-point potentiometer).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/micropelt/mlrtps1.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// Wire format (fPort 1, 4 bytes):
//   byte[0]  UINT8  ambient temperature, x0.25 degC -> air.temperature
//   byte[1]  status bitfield:
//              bit5  PIR_Status (1 = motion/occupancy detected) -> action.motion.detected
//              bit4  Energy_Storage_Low                         -> extra energyStorageLow
//              bit3  Radio_Communication_Error                  -> extra radioCommunicationError
//              bit2  Radio_Signal_Strength                      -> extra radioSignalStrength
//              bit1  PIR_Sensor_Failure                         -> extra pirSensorFailure
//              bit0  Ambient_Temperature_Failure                -> extra ambientTemperatureFailure
//   byte[2]  UINT8  storage (energy harvest) voltage, x0.02 V   -> battery (V)
//   byte[3]  UINT8  manual set-point potentiometer offset code  -> extra setPointTemperature
//
// `air.temperature` is the ambient room temperature measured by the device, so
// it normalizes to the vocabulary climate key. The set-point value is a manual
// heating-control offset selected by the radiator dial (a relative setpoint
// code, not an ambient measurement), so it is emitted as the camelCase extra
// `setPointTemperature` rather than a `*.temperature` vocabulary key. Storage
// voltage is already in volts, so it maps directly to `battery`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function setPointValue(b) {
  switch (b) {
    case 0: return '0';
    case 1: return '+1';
    case 2: return '+2';
    case 3: return '+3';
    case 4: return '+4';
    case 5: return '+5';
    case 12: return '-4';
    case 13: return '-3';
    case 14: return '-2';
    case 15: return '-1';
    case 255: return 'Freeze Protection 6°';
    default: return '0';
  }
}

function decodeUplinkCore(input) {
  if (input.fPort !== 1) {
    return { errors: ['unknown FPort ' + input.fPort] };
  }

  var bytes = input.bytes;
  if (!bytes || bytes.length < 4) {
    return { errors: ['expected 4 bytes on FPort 1, got ' + (bytes ? bytes.length : 0)] };
  }

  var status = bytes[1];

  var data = {
    air: {
      temperature: round(bytes[0] * 0.25, 2)
    },
    action: {
      motion: {
        detected: ((status >> 5) & 0x01) === 1
      }
    },
    battery: round(bytes[2] * 0.02, 2),
    setPointTemperature: setPointValue(bytes[3]),
    energyStorageLow: ((status >> 4) & 0x01) === 1,
    radioCommunicationError: ((status >> 3) & 0x01) === 1,
    radioSignalStrength: ((status >> 2) & 0x01) === 1,
    pirSensorFailure: ((status >> 1) & 0x01) === 1,
    ambientTemperatureFailure: (status & 0x01) === 1
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "micropelt";
    result.data.model = "mlrtps1";
  }
  return result;
}
