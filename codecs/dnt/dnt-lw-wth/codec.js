// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dnt LoRaWAN Wall Thermostat (dnt-lw-wth).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (a self-describing command stream: each field begins with a
// command/parameter id byte, followed by that field's payload) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dnt/dnt-lw-wth.js, attributed in
// NOTICE). The decode is ported faithfully from that reference; we do NOT copy
// upstream normalizeUplink.
//
// The wall thermostat is an indoor climate sensor (room temperature + relative
// humidity) wrapped around a heating/cooling controller. Mappings:
//   room temperature (CMD_GET_STATUS bit 0x02 / CMD_GET_ROOM_TEMPERATURE,
//     16-bit big-endian tenths of a degree) -> air.temperature (degC)
//   room humidity   (CMD_GET_STATUS bit 0x04 / CMD_GET_HUMIDITY, percent)
//     -> air.relativeHumidity
//   battery voltage (CMD_GET_STATUS bit 0x01 / CMD_GET_BAT_VOLTAGE,
//     code -> millivolts) -> battery (V), code*10 + 1500 then /1000
// The upstream reference leaves room_temperature as a raw integer (e.g. 219); it
// is in tenths of a degree, so we apply the /10 the reference omits to land a
// real Celsius value (21.9), as required by the vocabulary's air.temperature.
//
// Every other decoded field is heating-controller state with no vocabulary
// home, so it is surfaced as a camelCase extra (setPointTemperature, miscFlags,
// activeMode, deviceError, ...). Set-point and offset values are degrees Celsius
// numbers (the upstream .toFixed string quirk is dropped). Truncated command
// payloads return { errors }.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var POSSIBLE_ACTIVE_MODES = [
  'MODE_MANU',
  'MODE_AUTO_LOW_POWER',
  'MODE_AUTO',
  'MODE_HOLIDAY',
  'MODE_EMERGENCY',
  'MODE_FROST_PROTECTION',
  'INVALID',
  'MODE_WINDOW_OPEN',
  'MODE_HOLIDAY'
];

var DEVICE_ERRORS = ['NO_ERROR', 'SHT20_ERROR'];

// Command / parameter ids (from the upstream reference).
var CMD_GET_STATUS_INTERVAL = 0;
var CMD_GET_STATUS_PARAMETER_ENABLE_REGISTER = 2;
var CMD_GET_STATUS = 4;
var CMD_GET_BAT_VOLTAGE = 5;
var CMD_GET_ACTIVE_MODE = 6;
var CMD_GET_ERROR = 7;
var CMD_GET_SET_POINT = 33;
var CMD_GET_TEMPERATURE_OFFSET = 36;
var CMD_GET_ROOM_TEMPERATURE = 38;
var CMD_GET_WINDOW_OPEN_STATUS = 46;
var CMD_GET_DISPLAY_MODE = 55;
var CMD_GET_MINIMUM_SET_POINT = 57;
var CMD_GET_MAXIMUM_SET_POINT = 59;
var CMD_GET_MINIMUM_HOLIDAY_SET_POINT = 61;
var CMD_GET_MAXIMUM_HOLIDAY_SET_POINT = 63;
var CMD_GET_HOLIDAY_SET_POINT = 65;
var CMD_GET_HUMIDITY = 67;
var RESPONSE_CMD_FAILED = 54;
var GET_HW_LOCK = 245;
var GET_LORAWAN_DATARATE = 248;

// Status enable-register bit flags.
var STATUS_PARAM_BAT_VOLTAGE_BIT = 0x01;
var STATUS_PARAM_CTRL_INPUT_ROOM_TEMPERATURE = 0x02;
var STATUS_PARAM_CTRL_INPUT_ROOM_HUMIDITY = 0x04;
var STATUS_PARAM_CTRL_INPUT_SET_POINT_TEMPERATURE = 0x08;
var STATUS_PARAM_CTRL_MISC_FLAGS = 0x10;

var MISC_FLAG_WINDOW_OPEN = 0x01;
var MISC_FLAG_HOLIDAY_MODE_PENDING = 0x02;
var MISC_FLAG_CURRENT_MODE_MSK = 0x04 | 0x08;
var MISC_FLAG_TEMPERATURE_NOT_RISING = 0x10;

// Convert a battery-voltage code to volts: code*10 + 1500 (millivolts) / 1000.
function batteryVolts(code) {
  return round((code * 10 + 1500) / 1000, 3);
}

// Convert a 16-bit big-endian tenths-of-a-degree value to Celsius.
function roomTempC(hi, lo) {
  return round((((hi << 8) | lo) & 0xffff) / 10, 1);
}

function decodeUplink(input) {
  var payload = input.bytes;
  if (!payload || payload.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var index = 0;
  var recognized = false;

  // Bounds helper: every field must have `need` bytes left after its id.
  function ensure(need) {
    return index + need <= payload.length;
  }

  while (index < payload.length) {
    var field = payload[index++];

    if (field === CMD_GET_STATUS_INTERVAL) {
      if (!ensure(1)) {
        return { errors: ['truncated status-interval field'] };
      }
      data.statusInterval = payload[index++] * 30 + 30;
      recognized = true;
    } else if (field === CMD_GET_STATUS_PARAMETER_ENABLE_REGISTER) {
      if (!ensure(1)) {
        return { errors: ['truncated status-parameter register field'] };
      }
      data.statusParamEnableRegister = payload[index++];
      recognized = true;
    } else if (field === CMD_GET_STATUS) {
      if (!ensure(1)) {
        return { errors: ['truncated status field'] };
      }
      var txEnReg = payload[index++];
      if (txEnReg & STATUS_PARAM_BAT_VOLTAGE_BIT) {
        if (!ensure(1)) {
          return { errors: ['truncated status battery field'] };
        }
        data.battery = batteryVolts(payload[index++]);
      }
      if (txEnReg & STATUS_PARAM_CTRL_INPUT_ROOM_TEMPERATURE) {
        if (!ensure(2)) {
          return { errors: ['truncated status temperature field'] };
        }
        air.temperature = roomTempC(payload[index], payload[index + 1]);
        index += 2;
      }
      if (txEnReg & STATUS_PARAM_CTRL_INPUT_ROOM_HUMIDITY) {
        if (!ensure(1)) {
          return { errors: ['truncated status humidity field'] };
        }
        air.relativeHumidity = payload[index++];
      }
      if (txEnReg & STATUS_PARAM_CTRL_INPUT_SET_POINT_TEMPERATURE) {
        if (!ensure(1)) {
          return { errors: ['truncated status set-point field'] };
        }
        data.setPointTemperature = round(payload[index++] * 0.5, 1);
      }
      if (txEnReg & STATUS_PARAM_CTRL_MISC_FLAGS) {
        if (!ensure(1)) {
          return { errors: ['truncated status misc-flags field'] };
        }
        var flags = payload[index++];
        var misc = {};
        misc.windowOpen = flags & MISC_FLAG_WINDOW_OPEN ? 1 : 0;
        misc.holidayModePending = flags & MISC_FLAG_HOLIDAY_MODE_PENDING ? 1 : 0;
        misc.activeMode =
          POSSIBLE_ACTIVE_MODES[(flags & MISC_FLAG_CURRENT_MODE_MSK) >> 2];
        if (flags & MISC_FLAG_TEMPERATURE_NOT_RISING) {
          misc.temperatureTooLow = 1;
        }
        data.miscFlags = misc;
      }
      recognized = true;
    } else if (field === CMD_GET_BAT_VOLTAGE) {
      if (!ensure(1)) {
        return { errors: ['truncated battery-voltage field'] };
      }
      data.battery = batteryVolts(payload[index++]);
      recognized = true;
    } else if (field === CMD_GET_ACTIVE_MODE) {
      if (!ensure(1)) {
        return { errors: ['truncated active-mode field'] };
      }
      data.activeMode = POSSIBLE_ACTIVE_MODES[payload[index++]];
      recognized = true;
    } else if (field === CMD_GET_ERROR) {
      if (!ensure(1)) {
        return { errors: ['truncated error field'] };
      }
      data.deviceError = DEVICE_ERRORS[payload[index++]];
      recognized = true;
    } else if (field === CMD_GET_SET_POINT) {
      if (!ensure(1)) {
        return { errors: ['truncated set-point field'] };
      }
      data.setPointTemperature = round(payload[index++] * 0.5, 1);
      recognized = true;
    } else if (field === CMD_GET_TEMPERATURE_OFFSET) {
      if (!ensure(1)) {
        return { errors: ['truncated temperature-offset field'] };
      }
      data.temperatureOffset = round(payload[index++] * 0.1 - 6.4, 1);
      recognized = true;
    } else if (field === CMD_GET_ROOM_TEMPERATURE) {
      if (!ensure(2)) {
        return { errors: ['truncated room-temperature field'] };
      }
      air.temperature = roomTempC(payload[index], payload[index + 1]);
      index += 2;
      recognized = true;
    } else if (field === CMD_GET_WINDOW_OPEN_STATUS) {
      if (!ensure(1)) {
        return { errors: ['truncated window-open-status field'] };
      }
      data.windowOpenStatus = payload[index++];
      recognized = true;
    } else if (field === RESPONSE_CMD_FAILED) {
      if (!ensure(1)) {
        return { errors: ['truncated failed-commands field'] };
      }
      var nbFailed = payload[index++];
      if (!ensure(nbFailed)) {
        return { errors: ['truncated failed-commands list'] };
      }
      var failed = [];
      for (var f = 0; f < nbFailed; f++) {
        failed.push(payload[index++]);
      }
      data.failedCommands = failed;
      recognized = true;
    } else if (field === CMD_GET_DISPLAY_MODE) {
      if (!ensure(1)) {
        return { errors: ['truncated display-mode field'] };
      }
      data.displayMode = payload[index++];
      recognized = true;
    } else if (field === CMD_GET_MINIMUM_SET_POINT) {
      if (!ensure(1)) {
        return { errors: ['truncated minimum-set-point field'] };
      }
      data.minimumSetPointTemperature = round(payload[index++] * 0.5, 1);
      recognized = true;
    } else if (field === CMD_GET_MAXIMUM_SET_POINT) {
      if (!ensure(1)) {
        return { errors: ['truncated maximum-set-point field'] };
      }
      data.maximumSetPointTemperature = round(payload[index++] * 0.5, 1);
      recognized = true;
    } else if (field === CMD_GET_MINIMUM_HOLIDAY_SET_POINT) {
      if (!ensure(1)) {
        return { errors: ['truncated minimum-holiday-set-point field'] };
      }
      data.minimumHolidaySetPointTemperature = round(payload[index++] * 0.5, 1);
      recognized = true;
    } else if (field === CMD_GET_MAXIMUM_HOLIDAY_SET_POINT) {
      if (!ensure(1)) {
        return { errors: ['truncated maximum-holiday-set-point field'] };
      }
      data.maximumHolidaySetPointTemperature = round(payload[index++] * 0.5, 1);
      recognized = true;
    } else if (field === CMD_GET_HOLIDAY_SET_POINT) {
      if (!ensure(1)) {
        return { errors: ['truncated holiday-set-point field'] };
      }
      data.holidaySetPointTemperature = round(payload[index++] * 0.5, 1);
      recognized = true;
    } else if (field === CMD_GET_HUMIDITY) {
      if (!ensure(1)) {
        return { errors: ['truncated humidity field'] };
      }
      air.relativeHumidity = payload[index++];
      recognized = true;
    } else if (field === GET_HW_LOCK) {
      if (!ensure(1)) {
        return { errors: ['truncated hardware-lock field'] };
      }
      data.deviceHwLock = payload[index++];
      recognized = true;
    } else if (field === GET_LORAWAN_DATARATE) {
      if (!ensure(1)) {
        return { errors: ['truncated datarate field'] };
      }
      data.datarateConfig = payload[index++];
      recognized = true;
    } else {
      return { errors: ['unsupported command 0x' + field.toString(16)] };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized dnt commands'] };
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }

  return { data: data };
}
