// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight WT401 (Wireless Smart Thermostat with
// PIR occupancy detection, ambient temperature & humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight TSL command-id stream) was ported from the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/wt401.js, in turn Milesight-IoT/SensorDecoders,
// attributed in NOTICE). The command-walk and field extraction are reproduced
// faithfully; only the JSON shape is re-authored to the normalized vocabulary
// (never the upstream output).
//
// Mapping decisions:
//   0x00 battery (byte %)                 -> batteryPercent extra (vocab battery is V)
//   0x01 ambient temperature (s16/100, C) -> air.temperature
//   0x02 ambient humidity (u16/10, %)     -> air.relativeHumidity
//   0x08 pir_status (occupancy)           -> action.motion.detected
//        (vacant -> false, occupied/night_occupied -> true); pirStatus extra
//        preserves the raw three-state string.
//   thermostat valve config (mode, fan, plan, target/setpoint temps, alarms,
//        events, device status) -> camelCase extras. Valve setpoint/target
//        temperatures are NOT ambient readings and never go to air.temperature.
//
// The PIR occupancy channel is the category-defining state for `motion`:
// occupancy is reported as action.motion.detected (boolean). Milesight reports
// battery as a PERCENTAGE; the vocabulary's `battery` is volts, so the
// percentage is emitted as the camelCase extra `batteryPercent`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(b) {
  return b & 0xff;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function getValue(map, key) {
  var value = map[key];
  if (!value) value = 'unknown';
  return value;
}

function readTemperatureControlMode(mode) {
  return getValue({ 0: 'heat', 1: 'em_heat', 2: 'cool', 3: 'auto', 10: 'off', 11: 'NA' }, mode);
}

function readFanMode(mode) {
  return getValue({ 0: 'auto', 1: 'circulate', 2: 'on', 3: 'low', 4: 'medium', 5: 'high', 10: 'off', 11: 'NA' }, mode);
}

function readPlan(id) {
  var map = {
    0: 'plan_1', 1: 'plan_2', 2: 'plan_3', 3: 'plan_4', 4: 'plan_5', 5: 'plan_6',
    6: 'plan_7', 7: 'plan_8', 8: 'plan_9', 9: 'plan_10', 10: 'plan_11', 11: 'plan_12',
    12: 'plan_13', 13: 'plan_14', 14: 'plan_15', 15: 'plan_16', 255: 'none'
  };
  return getValue(map, id);
}

function readPirStatus(status) {
  return getValue({ 0: 'vacant', 1: 'occupied', 2: 'night_occupied' }, status);
}

function readBleEvent(event) {
  return getValue({ 0: 'none', 1: 'peer_cancel', 2: 'disconnect' }, event);
}

function readPowerBusEvent(event) {
  return getValue({ 0: 'none', 1: 'communication_error' }, event);
}

function readTemperatureAlarm(type) {
  return getValue({ 0: 'collection_error', 1: 'lower_range_error', 2: 'over_range_error', 3: 'no_data' }, type);
}

function readHumidityAlarm(type) {
  return getValue({ 0: 'collection_error', 1: 'lower_range_error', 2: 'over_range_error', 3: 'no_data' }, type);
}

function readButtonEvent(event) {
  return getValue({ 0: 'F1', 1: 'F2', 2: 'F3' }, event);
}

function readBatteryEvent(event) {
  return getValue({ 0: 'recover', 1: 'low_voltage' }, event);
}

function readDeviceStatus(type) {
  return getValue({ 0: 'off', 1: 'on' }, type);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var action = {};
  var motion = {};
  var hasAir = false;
  var hasMotion = false;
  var recognized = false;

  var i = 0;
  while (i < bytes.length) {
    var cmd = bytes[i++];

    if (cmd === 0x00) {
      // BATTERY (percentage)
      data.batteryPercent = u8(bytes[i]);
      i += 1;
      recognized = true;
    } else if (cmd === 0x01) {
      // AMBIENT TEMPERATURE (s16 LE / 100, degC)
      air.temperature = round(s16le(bytes[i], bytes[i + 1]) / 100, 2);
      hasAir = true;
      i += 2;
      recognized = true;
    } else if (cmd === 0x02) {
      // AMBIENT HUMIDITY (u16 LE / 10, %)
      air.relativeHumidity = round(u16le(bytes[i], bytes[i + 1]) / 10, 1);
      hasAir = true;
      i += 2;
      recognized = true;
    } else if (cmd === 0x03) {
      data.temperatureControlMode = readTemperatureControlMode(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x04) {
      data.fanMode = readFanMode(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x05) {
      data.executionPlan = readPlan(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x06) {
      data.targetTemperature1 = round(s16le(bytes[i], bytes[i + 1]) / 100, 2);
      i += 2;
      recognized = true;
    } else if (cmd === 0x07) {
      data.targetTemperature2 = round(s16le(bytes[i], bytes[i + 1]) / 100, 2);
      i += 2;
      recognized = true;
    } else if (cmd === 0x08) {
      // PIR OCCUPANCY: 0 vacant, 1 occupied, 2 night_occupied
      var pir = u8(bytes[i]);
      motion.detected = pir !== 0;
      data.pirStatus = readPirStatus(pir);
      hasMotion = true;
      i += 1;
      recognized = true;
    } else if (cmd === 0x09) {
      data.bleEvent = readBleEvent(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x0a) {
      data.powerBusEvent = readPowerBusEvent(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x0b) {
      data.temperatureAlarm = readTemperatureAlarm(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x0c) {
      data.humidityAlarm = readHumidityAlarm(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x0d) {
      data.buttonEvent = readButtonEvent(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0x0f) {
      data.batteryEvent = readBatteryEvent(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else if (cmd === 0xc8) {
      data.deviceStatus = readDeviceStatus(u8(bytes[i]));
      i += 1;
      recognized = true;
    } else {
      // Unknown / unhandled command id (config/service/attribute frames not
      // modeled here). Faithful to upstream's fail-fast behavior: report
      // rather than silently misalign the stream.
      return { errors: ['unknown command: ' + cmd] };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasMotion) {
    action.motion = motion;
    data.action = action;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "wt401";
  }
  return result;
}
