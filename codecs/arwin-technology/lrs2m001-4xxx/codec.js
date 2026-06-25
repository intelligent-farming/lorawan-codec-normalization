// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for arwin-technology/lrs2m001-4xxx
// (LRS2M001-4P3P Power Monitoring Sensor).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/arwin-technology/lrs2m001-4xxx.js,
// attributed in NOTICE). Wire format preserved; output normalized to the
// shared vocabulary. Upstream normalizeUplink was NOT copied.
//
// Wire format:
//   fPort 10, bytes[0]==0x0a: 3-phase meter voltage/frequency
//     bytes[1..2] = phase A voltage (V x10)
//     bytes[3..4] = phase B voltage (V x10)
//     bytes[5..6] = phase C voltage (V x10)
//     bytes[7..9] = 24-bit field: top 14 bits = frequency (Hz),
//                   low 10 bits = event bitmask (meter events)
//     bytes[10]   = backup battery percentage (0..100)
//   fPort 50..61, bytes[0]==0x0a: per-channel/phase electrical data
//     channel/phase derived from fPort (50->ch1 A .. 61->ch4 C)
//     bytes[1..2] : top 2 bits = phase event bitmask, low 14 bits = current (A x10)
//     bytes[3..6] : 32-bit field; top 22 bits (signed) = active power (W x10),
//                   low 10 bits = power factor (x1000)
//     bytes[7..10]: active energy (kWh x10)
//   fPort 8: firmware version (major . minor . patch16)
//   fPort 16, bytes[0]==0x0a: device settings

var LRS2M001_METER_EVENTS = ['heartbeat/button', 'bakcup power', 'ph_C_under_V', 'ph_C_over_V', 'ph_B_under_V', 'ph_B_over_V', 'ph_A_under_V', 'ph_A_over_V', 'backup_batt_low'];
var LRS2M001_PHASE_EVENTS = ['over_current', 'heartbeat/button'];

// fPort -> [channel, phase]
var LRS2M001_PHASE_MAP = {
  50: [1, 'A'], 51: [1, 'B'], 52: [1, 'C'],
  53: [2, 'A'], 54: [2, 'B'], 55: [2, 'C'],
  56: [3, 'A'], 57: [3, 'B'], 58: [3, 'C'],
  59: [4, 'A'], 60: [4, 'B'], 61: [4, 'C']
};

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// 22-bit two's-complement to signed int
function s22(hex) {
  var dec = hex & 0x3fffff;
  if (dec & 0x200000) {
    dec = -(0x400000 - dec);
  }
  return dec;
}

function decodePhase(bytes, channel, phase) {
  if (bytes[0] !== 0x0a) {
    return { errors: ['unknown packet type'] };
  }
  var evtAmp = bytes[1] << 8 | bytes[2];
  var powPf = (bytes[3] << 24 | bytes[4] << 16 | bytes[5] << 8 | bytes[6]) >>> 0;
  var evt = '';
  var i;
  for (i = 0; i < 2; i++) {
    if ((0x01 << i) & (evtAmp >> 14)) {
      if (evt === '') {
        evt = LRS2M001_PHASE_EVENTS[i];
      } else {
        evt = evt + ',' + LRS2M001_PHASE_EVENTS[i];
      }
    }
  }
  // active energy: source is kWh x10 -> normalize to Wh (kWh x 1000)
  var energyKwh = (bytes[7] << 24 | bytes[8] << 16 | bytes[9] << 8 | bytes[10]) / 10;
  return {
    data: {
      power: {
        current: round((evtAmp & 0x3fff) / 10, 1),
        active: round(s22(powPf >>> 10) / 10, 1),
        factor: round((powPf & 0x03ff) / 1000, 3)
      },
      metering: {
        energy: {
          total: round(energyKwh * 1000, 0)
        }
      },
      channel: channel,
      phase: phase,
      event: evt
    }
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  switch (input.fPort) {
    case 10: // 3-phase meter voltage / frequency
      if (bytes[0] !== 0x0a) {
        return { errors: ['unknown packet type'] };
      }
      var freqEvt = bytes[7] << 16 | bytes[8] << 8 | bytes[9];
      var evt = '';
      var i;
      for (i = 0; i < 10; i++) {
        if ((0x01 << i) & freqEvt) {
          if (evt === '') {
            evt = LRS2M001_METER_EVENTS[i];
          } else {
            evt = evt + ',' + LRS2M001_METER_EVENTS[i];
          }
        }
      }
      return {
        data: {
          power: {
            voltage: round((bytes[1] << 8 | bytes[2]) / 10, 1),
            frequency: freqEvt >> 10
          },
          phaseBVoltage: round((bytes[3] << 8 | bytes[4]) / 10, 1),
          phaseCVoltage: round((bytes[5] << 8 | bytes[6]) / 10, 1),
          batteryPercent: bytes[10],
          event: evt
        }
      };
    case 50:
    case 51:
    case 52:
    case 53:
    case 54:
    case 55:
    case 56:
    case 57:
    case 58:
    case 59:
    case 60:
    case 61:
      var cp = LRS2M001_PHASE_MAP[input.fPort];
      return decodePhase(bytes, cp[0], cp[1]);
    case 8: // firmware version
      var ver = bytes[0] + '.' + ('00' + bytes[1]).slice(-2) + '.' + ('000' + (bytes[2] << 8 | bytes[3])).slice(-3);
      return {
        data: {
          firmwareVersion: ver
        }
      };
    case 16: // device settings
      if (bytes[0] !== 0x0a) {
        return { errors: ['unknown packet type'] };
      }
      return {
        data: {
          dataUploadInterval: bytes[1] << 8 | bytes[2],
          underVoltageLimit: bytes[3] << 8 | bytes[4],
          overVoltageLimit: bytes[5] << 8 | bytes[6],
          overCurrentLimit: bytes[7] << 8 | bytes[8]
        }
      };
    default:
      return { errors: ['unknown FPort'] };
  }
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "arwin-technology";
    result.data.model = "lrs2m001-4xxx";
  }
  return result;
}
