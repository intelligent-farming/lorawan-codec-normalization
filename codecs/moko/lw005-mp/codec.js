// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for moko/lw005-mp (MOKO LW005-MP LoRaWAN smart plug /
// single-phase power meter: voltage, current, active power, power factor, line
// frequency, cumulative energy, relay/load state, and protection alarms).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/moko/lw005-mp.js, attributed in
// NOTICE). Wire format understood from that reference; normalization authored
// here. Every frame begins with a 4-byte big-endian epoch timestamp and a
// 1-byte timezone offset (half-hour units); the fPort selects the record type.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function parseInt16(num) {
  if (num & 0x8000) {
    return num - 0x10000;
  }
  return num;
}

function parseInt24(num) {
  if (num & 0x800000) {
    return num - 0x1000000;
  }
  return num;
}

// Length each fPort must have (timestamp[4] + timezone[1] + payload).
function expectedLength(port) {
  switch (port) {
    case 5: return 7;
    case 6: return 11;
    case 7: return 10;
    case 8: return 11;
    case 9: return 10;
    case 10: return 10;
    case 11: return 10;
    case 12: return 11;
    case 13: return 6;
    case 14: return 10;
    default: return -1;
  }
}

function rfc3339(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

function relayWord(value) {
  return value ? 'on' : 'off';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var need = expectedLength(port);
  if (need < 0) {
    return { errors: ['unsupported fPort ' + port] };
  }
  if (bytes.length !== need) {
    return {
      errors: [
        'payload length ' + bytes.length + ' does not match fPort ' + port +
          ' (expected ' + need + ')'
      ]
    };
  }

  var data = {};
  var epoch = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
  data.time = rfc3339(epoch);

  switch (port) {
    case 5:
      // Switch (relay) and load on/off state.
      data.relayState = relayWord(bytes[5]);
      data.loadState = relayWord(bytes[6]);
      break;

    case 6:
      // Instantaneous voltage / current / line frequency.
      data.power = {
        voltage: round((bytes[5] << 8 | bytes[6]) / 10, 1),
        current: round(parseInt16(bytes[7] << 8 | bytes[8]) / 1000, 3),
        frequency: round((bytes[9] << 8 | bytes[10]) / 1000, 3)
      };
      break;

    case 7:
      // Active power (W) and power factor (raw 0..100 -> -1..1).
      data.power = {
        active: round((bytes[5] << 24 | bytes[6] << 16 | bytes[7] << 8 | bytes[8]) / 10, 1),
        factor: round(bytes[9] / 100, 2)
      };
      break;

    case 8:
      // Cumulative active energy (Wh) plus the last full hour's consumption.
      data.metering = {
        energy: {
          total: (bytes[5] << 24 | bytes[6] << 16 | bytes[7] << 8 | bytes[8]) >>> 0
        }
      };
      data.lastHourEnergyWh = bytes[9] << 8 | bytes[10];
      break;

    case 9:
      // Over-voltage alarm: current voltage and the configured protect level.
      data.power = { voltage: round((bytes[6] << 8 | bytes[7]) / 10, 1) };
      data.overVoltageState = bytes[5] ? 1 : 0;
      data.protectVoltage = round((bytes[8] << 8 | bytes[9]) / 10, 1);
      break;

    case 10:
      // Under-voltage alarm.
      data.power = { voltage: round((bytes[6] << 8 | bytes[7]) / 10, 1) };
      data.underVoltageState = bytes[5] ? 1 : 0;
      data.protectVoltage = round((bytes[8] << 8 | bytes[9]) / 10, 1);
      break;

    case 11:
      // Over-current alarm.
      data.power = { current: round(parseInt16(bytes[6] << 8 | bytes[7]) / 1000, 3) };
      data.overCurrentState = bytes[5] ? 1 : 0;
      data.protectCurrent = round((bytes[8] << 8 | bytes[9]) / 1000, 3);
      break;

    case 12:
      // Over-power alarm.
      data.power = { active: round(parseInt24(bytes[6] << 16 | bytes[7] << 8 | bytes[8]) / 10, 1) };
      data.overPowerState = bytes[5] ? 1 : 0;
      data.protectPower = round((bytes[9] << 8 | bytes[10]) / 10, 1);
      break;

    case 13:
      // Load-change report.
      data.loadChangeState = bytes[5];
      break;

    case 14:
      // Countdown timer status.
      data.countdownState = bytes[5];
      data.countdownTime = (bytes[6] << 24 | bytes[7] << 16 | bytes[8] << 8 | bytes[9]) >>> 0;
      break;

    default:
      return { errors: ['unsupported fPort ' + port] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "moko";
    result.data.model = "lw005-mp";
  }
  return result;
}
