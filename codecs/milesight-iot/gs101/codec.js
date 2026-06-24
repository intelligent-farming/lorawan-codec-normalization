// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight GS101 (LoRaWAN Gas Detector with
// smart valve / relay — alarm-only, reports gas state rather than a
// concentration).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/gs101.js, in
// turn Milesight-IoT/SensorDecoders, attributed in NOTICE). The channel-walk
// and field extraction are reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions (upstream channel/type -> normalized):
//   0x05/0x8e gas status   byte (0 = normal)       -> air.gasAlarm (boolean; true = abnormal)
//   0x06/0x01 valve        byte (0 = close)        -> valveState extra ('open' | 'close')
//   0x07/0x01 relay        byte (0 = close)        -> relayState extra ('open' | 'close')
//   0x08/0x90 sensor life  uint32 LE seconds       -> sensorLifeRemaining extra (seconds, number)
//   0xff/0x3f alarm info   byte enum               -> sensorAlarm extra (camelCase string)
//
// Notes:
//   - air.gasAlarm is a boolean per the vocabulary: upstream emits the strings
//     'normal' / 'abnormal'; the normalized codec emits air.gasAlarm = true when
//     the gas state is abnormal.
//   - The valve, relay, sensor-life and alarm fields are device-specific data the
//     vocabulary does not model, so they are emitted as camelCase extras.
//   - Upstream appends the unit string 's' to the remaining life (e.g. '3600s');
//     the normalized codec emits a plain number of seconds (sensorLifeRemaining).
//   - GS101 uplinks carry no battery channel, so no battery/batteryPercent field
//     is emitted.

function readUInt32LE(b0, b1, b2, b3) {
  var value = (b3 << 24) + (b2 << 16) + (b1 << 8) + b0;
  return (value & 0xffffffff) >>> 0;
}

function alarmName(code) {
  switch (code) {
    case 0:
      return 'powerDown';
    case 1:
      return 'powerOn';
    case 2:
      return 'sensorFailure';
    case 3:
      return 'sensorRecover';
    case 4:
      return 'sensorAboutToFail';
    case 5:
      return 'sensorFailed';
    default:
      return null;
  }
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x05 && type === 0x8e) {
      // GAS STATUS: byte, 0 = normal, nonzero = abnormal
      air.gasAlarm = bytes[i + 2] !== 0;
      hasAir = true;
      i += 3;
      recognized = true;
    } else if (channel === 0x06 && type === 0x01) {
      // VALVE: byte, 0 = close, nonzero = open
      data.valveState = bytes[i + 2] === 0 ? 'close' : 'open';
      i += 3;
      recognized = true;
    } else if (channel === 0x07 && type === 0x01) {
      // RELAY: byte, 0 = close, nonzero = open
      data.relayState = bytes[i + 2] === 0 ? 'close' : 'open';
      i += 3;
      recognized = true;
    } else if (channel === 0x08 && type === 0x90) {
      // SENSOR REMAINING LIFE: uint32 LE, seconds
      data.sensorLifeRemaining = readUInt32LE(
        bytes[i + 2],
        bytes[i + 3],
        bytes[i + 4],
        bytes[i + 5]
      );
      i += 6;
      recognized = true;
    } else if (channel === 0xff && type === 0x3f) {
      // ALARM INFO: byte enum
      var name = alarmName(bytes[i + 2]);
      if (name === null) {
        break;
      }
      data.sensorAlarm = name;
      i += 3;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "gs101";
  }
  return result;
}
