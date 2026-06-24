// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dnt LoRaWAN Window Sensor & Contact Interface
// (dnt-lw-wsci).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (a self-describing command stream: each field begins with a
// command-id byte followed by that command's payload) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dnt/dnt-lw-wsci.js, attributed in
// NOTICE). The decode is ported faithfully from that reference; we do NOT copy
// upstream's nested {value,unit} output shape.
//
// This is a door/window sensor with a hall-effect (reed) contact, an external
// input clamp (magnetic contact / glass-break) and a sabotage (tamper) contact.
// Mappings:
//   hall sensor state (COMMAND_ID_GET_HALL_SENSOR_STATE / GET_STATUS bit 5,
//     INPUT_STATE byte & 0x03: 0=LOW, 1=HIGH, 2=DISABLED) -> action.contactState
//     The hall sensor is the primary window/door reed: magnet present (window
//     closed) reads LOW, magnet away (window open) reads HIGH, so
//     LOW -> 'closed' and HIGH -> 'open'. The enum has no DISABLED member, so a
//     disabled hall sensor is surfaced as the extra hallSensorState instead.
//   battery voltage (GET_STATUS bit 7 / COMMAND_ID_GET_BATTERY_VOLTAGE,
//     code -> code*10 + 1500 millivolts) -> battery (V), /1000.
//
// Upstream emits battery as a `.toFixed(0)` STRING in millivolts; the
// vocabulary's `battery` is a numeric voltage, so we convert mV -> V and emit a
// number. Everything else upstream decodes is device-specific state with no
// vocabulary home and is surfaced as camelCase extras:
//   input clamp state (external contact input)   -> inputClampState (LOW/HIGH/DISABLED)
//   sabotage contact state (tamper)              -> sabotageContactState (IDLE/TRIGGERED/DISABLED)
//   error code                                   -> errorCode
//   failed commands list                         -> failedCommands (array of ids)
//   hardware factory-reset lock                  -> hwFactoryResetLocked
//   data rate                                    -> dataRate
//   firmware/version block                       -> version
//   status interval                              -> statusInterval (s)
//   tx-enable register flags                     -> statusParamTxEnableRegister
// Config-only and device-time commands the device can also emit are decoded as
// generic extras as well. A second hall/clamp contact cannot both own
// action.contactState, so the input clamp stays an extra. Truncated command
// payloads return { errors }.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var INPUT_STATE = ['LOW', 'HIGH', 'DISABLED'];
var SABOTAGE_CONTACT_STATE = ['IDLE', 'TRIGGERED', 'DISABLED'];
var INPUT_CLAMP_SENSOR_TYPE = ['Magnetic contact', 'Glass break detector', 'Reserved'];
var ERROR_CODE = { 0: 'DEVICE_READY' };
var DATA_RATE = [
  'Adaptive Data Rate',
  'DR 0',
  'DR 1',
  'DR 2',
  'DR 3',
  'DR 4',
  'DR 5'
];

// Command ids (from the upstream reference).
var CMD_GET_STATUS_INTERVAL = 0;
var CMD_GET_STATUS_PARAMETER_TX_ENABLE_REGISTER = 2;
var CMD_GET_STATUS = 4;
var CMD_GET_BATTERY_VOLTAGE = 5;
var CMD_GET_SABOTAGE_CONTACT_STATE = 6;
var CMD_GET_ERROR_CODE = 7;
var CMD_GET_SABOTAGE_CONTACT_CONFIG = 13;
var CMD_GET_HALL_SENSOR_STATE = 14;
var CMD_GET_HALL_SENSOR_CONFIG = 16;
var CMD_GET_INPUT_CLAMP_STATE = 17;
var CMD_GET_INPUT_CLAMP_CONFIG = 19;
var CMD_GET_INPUT_CLAMP_SENSOR_TYPE = 21;
var CMD_GET_INPUT_CLAMP_SENSOR_FILTER_TIME = 23;
var CMD_COMMAND_FAILED = 54;
var CMD_GET_HARDWARE_FACTORY_RESET_LOCK = 57;
var CMD_GET_DATA_RATE = 248;
var CMD_GET_VERSION = 255;

// GET_STATUS tx-enable register bit flags.
var STATUS_BIT_BATTERY_VOLTAGE = 1 << 7;
var STATUS_BIT_SABOTAGE = 1 << 6;
var STATUS_BIT_HALL_SENSOR = 1 << 5;
var STATUS_BIT_INPUT_CLAMP = 1 << 4;

// Convert a battery-voltage code to volts: (code*10 + 1500) mV / 1000.
function batteryVolts(code) {
  return round((code * 10 + 1500) / 1000, 3);
}

// Map a hall INPUT_STATE byte to the action.contactState enum. LOW (magnet
// present, window closed) -> 'closed'; HIGH (magnet away, window open) ->
// 'open'. Returns null for DISABLED / unknown so the caller can fall back to an
// extra.
function hallContactState(raw) {
  var state = raw & 0x03;
  if (state === 0) {
    return 'closed';
  }
  if (state === 1) {
    return 'open';
  }
  return null;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var action = {};
  var hasAction = false;
  var index = 0;
  var recognized = false;

  // Bounds helper: `need` bytes must remain after the command id.
  function ensure(need) {
    return index + need <= bytes.length;
  }

  function applyHall(raw) {
    var cs = hallContactState(raw);
    if (cs !== null) {
      action.contactState = cs;
      hasAction = true;
    } else {
      data.hallSensorState = INPUT_STATE[raw & 0x03];
    }
  }

  while (index < bytes.length) {
    var command = bytes[index++];

    if (command === CMD_GET_STATUS_INTERVAL) {
      if (!ensure(1)) {
        return { errors: ['truncated status-interval field'] };
      }
      data.statusInterval = bytes[index++] * 360 + 30;
      recognized = true;
    } else if (command === CMD_GET_STATUS_PARAMETER_TX_ENABLE_REGISTER) {
      if (!ensure(1)) {
        return { errors: ['truncated tx-enable register field'] };
      }
      var reg = bytes[index++];
      data.statusParamTxEnableRegister = {
        batteryVoltageEnabled: !!(reg & STATUS_BIT_BATTERY_VOLTAGE),
        sabotageContactStatesEnabled: !!(reg & STATUS_BIT_SABOTAGE),
        hallSensorStatesEnabled: !!(reg & STATUS_BIT_HALL_SENSOR),
        inputClampStatesEnabled: !!(reg & STATUS_BIT_INPUT_CLAMP)
      };
      recognized = true;
    } else if (command === CMD_GET_STATUS) {
      if (!ensure(1)) {
        return { errors: ['truncated status field'] };
      }
      var txReg = bytes[index++];
      if (txReg & STATUS_BIT_BATTERY_VOLTAGE) {
        if (!ensure(1)) {
          return { errors: ['truncated status battery field'] };
        }
        data.battery = batteryVolts(bytes[index++]);
      }
      if (txReg & STATUS_BIT_SABOTAGE) {
        if (!ensure(1)) {
          return { errors: ['truncated status sabotage field'] };
        }
        data.sabotageContactState = SABOTAGE_CONTACT_STATE[bytes[index++] & 0x03];
      }
      if (txReg & STATUS_BIT_HALL_SENSOR) {
        if (!ensure(1)) {
          return { errors: ['truncated status hall-sensor field'] };
        }
        applyHall(bytes[index++]);
      }
      if (txReg & STATUS_BIT_INPUT_CLAMP) {
        if (!ensure(1)) {
          return { errors: ['truncated status input-clamp field'] };
        }
        data.inputClampState = INPUT_STATE[bytes[index++] & 0x03];
      }
      recognized = true;
    } else if (command === CMD_GET_BATTERY_VOLTAGE) {
      if (!ensure(1)) {
        return { errors: ['truncated battery-voltage field'] };
      }
      data.battery = batteryVolts(bytes[index++]);
      recognized = true;
    } else if (command === CMD_GET_SABOTAGE_CONTACT_STATE) {
      if (!ensure(1)) {
        return { errors: ['truncated sabotage-contact-state field'] };
      }
      data.sabotageContactState = SABOTAGE_CONTACT_STATE[bytes[index++] & 0x03];
      recognized = true;
    } else if (command === CMD_GET_ERROR_CODE) {
      if (!ensure(1)) {
        return { errors: ['truncated error-code field'] };
      }
      data.errorCode = ERROR_CODE[bytes[index++]];
      recognized = true;
    } else if (command === CMD_GET_SABOTAGE_CONTACT_CONFIG) {
      if (!ensure(1)) {
        return { errors: ['truncated sabotage-contact-config field'] };
      }
      data.sabotageContactConfig = !!(bytes[index++] & 0x01);
      recognized = true;
    } else if (command === CMD_GET_HALL_SENSOR_STATE) {
      if (!ensure(1)) {
        return { errors: ['truncated hall-sensor-state field'] };
      }
      applyHall(bytes[index++]);
      recognized = true;
    } else if (command === CMD_GET_HALL_SENSOR_CONFIG) {
      if (!ensure(1)) {
        return { errors: ['truncated hall-sensor-config field'] };
      }
      data.hallSensorConfig = !!(bytes[index++] & 0x01);
      recognized = true;
    } else if (command === CMD_GET_INPUT_CLAMP_STATE) {
      if (!ensure(1)) {
        return { errors: ['truncated input-clamp-state field'] };
      }
      data.inputClampState = INPUT_STATE[bytes[index++] & 0x03];
      recognized = true;
    } else if (command === CMD_GET_INPUT_CLAMP_CONFIG) {
      if (!ensure(1)) {
        return { errors: ['truncated input-clamp-config field'] };
      }
      data.inputClampConfig = !!(bytes[index++] & 0x01);
      recognized = true;
    } else if (command === CMD_GET_INPUT_CLAMP_SENSOR_TYPE) {
      if (!ensure(1)) {
        return { errors: ['truncated input-clamp-sensor-type field'] };
      }
      data.inputClampSensorType = INPUT_CLAMP_SENSOR_TYPE[bytes[index++] & 0x03];
      recognized = true;
    } else if (command === CMD_GET_INPUT_CLAMP_SENSOR_FILTER_TIME) {
      if (!ensure(1)) {
        return { errors: ['truncated input-clamp-filter-time field'] };
      }
      data.inputClampFilterTime = bytes[index++] * 30;
      recognized = true;
    } else if (command === CMD_COMMAND_FAILED) {
      if (!ensure(1)) {
        return { errors: ['truncated failed-commands field'] };
      }
      var nbFailed = bytes[index++];
      if (!ensure(nbFailed)) {
        return { errors: ['truncated failed-commands list'] };
      }
      var failed = [];
      for (var f = 0; f < nbFailed; f++) {
        failed.push(bytes[index++]);
      }
      data.failedCommands = failed;
      recognized = true;
    } else if (command === CMD_GET_HARDWARE_FACTORY_RESET_LOCK) {
      if (!ensure(1)) {
        return { errors: ['truncated hardware-factory-reset-lock field'] };
      }
      data.hwFactoryResetLocked = !!(bytes[index++] & 0x01);
      recognized = true;
    } else if (command === CMD_GET_DATA_RATE) {
      if (!ensure(1)) {
        return { errors: ['truncated data-rate field'] };
      }
      data.dataRate = DATA_RATE[bytes[index++] & 0x0f];
      recognized = true;
    } else if (command === CMD_GET_VERSION) {
      if (!ensure(13)) {
        return { errors: ['truncated version field'] };
      }
      var version = {};
      version.hwRevision = bytes[index++];
      version.application = [bytes[index++], bytes[index++], bytes[index++]];
      version.bootloader = [bytes[index++], bytes[index++], bytes[index++]];
      version.lorawanL2 = [bytes[index++], bytes[index++], bytes[index++]];
      version.payloadParser = [2, 0, 2];
      data.version = version;
      recognized = true;
    } else {
      return { errors: ['unsupported command 0x' + command.toString(16)] };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized dnt commands'] };
  }

  if (hasAction) {
    data.action = action;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dnt";
    result.data.model = "dnt-lw-wsci";
  }
  return result;
}
