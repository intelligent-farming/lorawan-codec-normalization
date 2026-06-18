// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MikroTik TG-LR8 (LoRa tag — onboard temperature
// and humidity sensor, magnetic switch, and an accelerometer reporting
// activity / impact / free-fall events).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mikrotik/tg-lrx2-2.0-ul-dec.js,
// attributed in NOTICE). The upstream decoder is ported faithfully below for
// the wire framing; the normalization to the shared vocabulary is authored
// here (do NOT copy upstream output keys).
//
// Wire framing (ported): an uplink begins on an application fPort (1..223).
// The fPort byte is prepended to the payload and the resulting stream is a
// sequence of frames. Each frame starts with a variable-length "frame type"
// encoding: bytes whose top two bits are 0b01 (BLOCK) or 0b10 (LAST_BLOCK)
// carry a 6-bit value; a LAST_BLOCK byte terminates the frame-type and the
// accumulated value is added (delta) to the previous frame's type. The frame
// body is then consumed by that type's decoder, and decoding continues with
// any remaining bytes (so a single uplink may carry several frames).
//
// NOTE ON CATEGORIES: this firmware codec decodes NO GNSS position — there is
// no latitude/longitude frame anywhere in the upstream decoder despite the
// product being marketed as a "tracker". Categories are therefore climate
// (air.temperature + air.relativeHumidity) and motion (accelerometer
// activity / impact / free-fall -> action.motion). Battery is reported in
// millivolts and normalized to volts in `battery`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var ACTIVITY_STATE_MASK = 0x03;
var ORIENTATION_MASK = 0x07;

function bytesToString(arr) {
  var s = '';
  for (var i = 0; i < arr.length; i++) {
    s += String.fromCharCode(arr[i]);
  }
  return s;
}

function activityState(value) {
  switch (value & ACTIVITY_STATE_MASK) {
    case 0:
      return 'IDLE';
    case 1:
      return 'LOW';
    case 2:
      return 'HIGH';
    default:
    case 3:
      return 'DISABLED';
  }
}

function majorOrientation(value) {
  switch (value & ORIENTATION_MASK) {
    case 0:
      return 'XH';
    case 1:
      return 'XL';
    case 2:
      return 'YH';
    case 3:
      return 'YL';
    case 4:
      return 'ZH';
    case 5:
      return 'ZL';
    default:
      return 'DISABLED';
  }
}

// Field decoder mirroring the upstream `decode(bytes, format)` helper. `bytes`
// is an array whose element 0 is the first byte of the field.
function decodeField(bytes, format) {
  if (format === 'bool') {
    return bytes[0] & 1 ? true : false;
  }
  if (format === 'u8') {
    return bytes[0];
  }
  if (format === 'i8') {
    return (bytes[0] << 24) >> 24;
  }
  if (format === 'i16') {
    return ((bytes[0] | (bytes[1] << 8)) << 16) >> 16;
  }
  if (format === 'u16') {
    return bytes[0] | (bytes[1] << 8);
  }
  if (format === 'u32') {
    // ">>> 0" keeps the result an unsigned 32-bit integer.
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  }
  if (format === 'f8.8') {
    return (((bytes[0] | (bytes[1] << 8)) << 16) >> 16) / 256;
  }
  if (format === 'orient') {
    return majorOrientation(bytes[0] & ORIENTATION_MASK);
  }
  if (format === 'activity') {
    return activityState(bytes[0] & ACTIVITY_STATE_MASK);
  }
  return 0;
}

// Variable table (frame type -> {name, fmt}) used by the device-events frame.
var VARIABLES = {
  0: { name: 'profile', fmt: 'u8' },
  1: { name: 'profile_etm', fmt: 'u32' },
  2: { name: 'daytime_tm', fmt: 'u32' },
  3: { name: 'unix_time', fmt: 'u32' },
  4: { name: 'net_frame_etm', fmt: 'u32' },
  5: { name: 'net_joined_flag', fmt: 'bool' },
  6: { name: 'net_class', fmt: 'u8' },
  7: { name: 'net_region', fmt: 'u8' },
  8: { name: 'temperature', fmt: 'f8.8' },
  9: { name: 'temperature_ema', fmt: 'f8.8' },
  10: { name: 'humidity', fmt: 'u8' },
  11: { name: 'humidity_ema', fmt: 'u8' },
  12: { name: 'mag_sw_cnt', fmt: 'u32' },
  13: { name: 'mag_sw_etm', fmt: 'u32' },
  14: { name: 'mag_sw_flag', fmt: 'bool' },
  15: { name: 'activity_state', fmt: 'activity' },
  16: { name: 'activity_s', fmt: 'u32' },
  17: { name: 'high_activity_s', fmt: 'u32' },
  18: { name: 'major_axis_orientation', fmt: 'orient' },
  19: { name: 'impact_cnt_x', fmt: 'u32' },
  20: { name: 'impact_cnt_y', fmt: 'u32' },
  21: { name: 'impact_cnt_z', fmt: 'u32' },
  22: { name: 'impact_cnt', fmt: 'u32' },
  23: { name: 'impact_evnt', fmt: 'bool' },
  24: { name: 'impact_etm', fmt: 'u32' },
  25: { name: 'free_fall_cnt', fmt: 'u32' },
  26: { name: 'free_fall_evnt', fmt: 'bool' },
  27: { name: 'free_fall_etm', fmt: 'u32' },
  28: { name: 'angle_1', fmt: 'u8' },
  29: { name: 'angle_2', fmt: 'u8' },
  30: { name: 'angle_3', fmt: 'u8' },
  31: { name: 'angle_ema', fmt: 'u8' },
  32: { name: 'battery_mv', fmt: 'u16' },
  33: { name: 'battery_mv_ema', fmt: 'u16' },
  35: { name: 'timer_1', fmt: 'u32' },
  36: { name: 'timer_2', fmt: 'u32' },
  37: { name: 'timer_3', fmt: 'u32' },
  38: { name: 'timer_4', fmt: 'u32' },
  39: { name: 'activity_state_etm', fmt: 'u32' }
};

// Take `n` bytes off the front of `bytes`, returning them as a new array
// (faithful port of upstream `bytes.splice(0, n)`).
function take(bytes, n) {
  return bytes.splice(0, n);
}

function decodeFragment(bytes) {
  var len = bytes[2];
  var pl = take(bytes, 3 + len);
  return {
    offset: (pl[0] | (pl[1] << 8)) & 0x7fff,
    len: pl[2],
    frag_bytes: pl.slice(3, 3 + pl[2]),
    final_frag: (pl[1] >> 7) & 0x1
  };
}

function utcIso(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

// Each frame decoder consumes its bytes from `bytes` (in place) and returns the
// raw fields it understood, mirroring the upstream frame_decoders table.
var FRAME_DECODERS = {
  1: function (bytes) {
    var pl = take(bytes, 5);
    return {
      temperature: decodeField(pl.slice(0), 'f8.8'),
      humidity: pl[2],
      mag_sw_cnt_u8: pl[3],
      major_axis_orientation: majorOrientation(pl[4]),
      activity_state: activityState(pl[4] >> 3),
      free_fall_evnt: (pl[4] >> 5) & 0x1,
      impact_evnt: (pl[4] >> 6) & 0x1,
      pending_evnt: (pl[4] >> 7) & 0x1
    };
  },
  2: function (bytes) {
    var lastEvent = false;
    var events = [];
    var maxEvents = 100;
    do {
      var eventLen = bytes[0] & 0x7f;
      lastEvent = ((bytes[0] >> 7) & 1) === 0;
      var pl = take(bytes, eventLen + 1);
      var timeStamp = decodeField(pl.slice(1), 'u32');
      var code = pl[5];
      var valueLen = Math.max(eventLen - 5, 0);
      var dataBytes = pl.slice(6, 6 + valueLen);
      var event = {
        time: utcIso(timeStamp),
        time_unix: timeStamp
      };
      var fieldName = 'sys-event';
      var fieldValue = code;
      if (VARIABLES.hasOwnProperty(code)) {
        fieldName = VARIABLES[code].name;
        fieldValue = decodeField(dataBytes, VARIABLES[code].fmt);
      } else if (code >= 100 && code <= 229) {
        fieldName = 'data_rule';
        fieldValue = code - 100;
      } else if (code === 230) {
        fieldName = 'cmd_error';
        fieldValue = decodeField(dataBytes, 'i16');
      } else if (code === 231) {
        fieldName = 'fault_address';
        fieldValue = decodeField(dataBytes, 'u32');
      }
      event[fieldName] = fieldValue;
      events.push(event);
      maxEvents--;
    } while (!lastEvent && maxEvents);
    return { events: events };
  },
  3: function (bytes) {
    var pl = take(bytes, 11);
    return {
      temp_histo_epoch: pl[0],
      temp_histo_bin1: pl[1],
      temp_histo_bin2: pl[2],
      temp_histo_bin3: pl[3],
      temp_histo_bin4: pl[4],
      temp_histo_bin5: pl[5],
      temp_histo_bin6: pl[6],
      temp_histo_bin7: pl[7],
      temp_histo_bin8: pl[8],
      temp_histo_bin9: pl[9],
      temp_histo_bin10: pl[10]
    };
  },
  4: function (bytes) {
    var pl = take(bytes, 11);
    return {
      humid_histo_epoch: pl[0],
      humid_histo_bin1: pl[1],
      humid_histo_bin2: pl[2],
      humid_histo_bin3: pl[3],
      humid_histo_bin4: pl[4],
      humid_histo_bin5: pl[5],
      humid_histo_bin6: pl[6],
      humid_histo_bin7: pl[7],
      humid_histo_bin8: pl[8],
      humid_histo_bin9: pl[9],
      humid_histo_bin10: pl[10]
    };
  },
  5: function (bytes) {
    var pl = take(bytes, 3);
    return {
      orientation_x: decodeField(pl.slice(0), 'i8'),
      orientation_y: decodeField(pl.slice(1), 'i8'),
      orientation_z: decodeField(pl.slice(2), 'i8')
    };
  },
  6: function (bytes) {
    var pl = take(bytes, 9);
    return {
      activity_state: activityState(pl[0]),
      activity_s: decodeField(pl.slice(1), 'u32'),
      high_activity_s: decodeField(pl.slice(5), 'u32')
    };
  },
  7: function (bytes) {
    var pl = take(bytes, 8);
    return {
      impact_cnt: decodeField(pl.slice(0), 'u32'),
      free_fall_cnt: decodeField(pl.slice(4), 'u32')
    };
  },
  8: function (bytes) {
    var pl = take(bytes, 8);
    var ts = decodeField(pl.slice(4), 'u32');
    return {
      mag_sw_cnt: decodeField(pl.slice(0), 'u32'),
      mag_switch_ts: ts,
      mag_switch_ts_gmt: utcIso(ts)
    };
  },
  9: function (bytes) {
    var pl = take(bytes, 8);
    return {
      impact_cnt_u16: decodeField(pl.slice(0), 'u16'),
      impact_cnt_x_u16: decodeField(pl.slice(2), 'u16'),
      impact_cnt_y_u16: decodeField(pl.slice(4), 'u16'),
      impact_cnt_z_u16: decodeField(pl.slice(6), 'u16')
    };
  },
  10: function (bytes) {
    var pl = take(bytes, 2);
    return { temperature: decodeField(pl.slice(0), 'f8.8') };
  },
  11: function (bytes) {
    var pl = take(bytes, 2);
    return { temperature_ema: decodeField(pl.slice(0), 'f8.8') };
  },
  12: function (bytes) {
    var pl = take(bytes, 1);
    return { humidity: pl[0] };
  },
  13: function (bytes) {
    var pl = take(bytes, 1);
    return { humidity_ema: pl[0] };
  },
  14: function (bytes) {
    var pl = take(bytes, 5);
    return {
      activity_state: activityState(pl[0]),
      total_activity_s: decodeField(pl.slice(1), 'u32')
    };
  },
  20: function (bytes) {
    var pl = take(bytes, 8);
    var ut = decodeField(pl.slice(4), 'u32');
    return {
      uptime_s: decodeField(pl.slice(0), 'u32'),
      unix_time: ut,
      dev_time: utcIso(ut)
    };
  },
  21: function (bytes) {
    var pl = take(bytes, 2);
    return { battery_mv: decodeField(pl.slice(0), 'u16') };
  },
  22: function (bytes) {
    var pl = take(bytes, 11);
    return {
      version_pid: decodeField(pl.slice(0), 'u16'),
      version_maj: pl[2],
      version_min: pl[3],
      version_rev: pl[4],
      version_hash: bytesToString(pl.slice(5, 11))
    };
  },
  23: function (bytes) {
    var pl = take(bytes, 11);
    return { serial_number: bytesToString(pl.slice(0, 11)) };
  },
  24: function (bytes) {
    var pl = take(bytes, 10);
    return {
      cfg_app_crc: decodeField(pl.slice(0), 'u16'),
      cfg_net_crc: decodeField(pl.slice(2), 'u16'),
      cfg_frames_crc: decodeField(pl.slice(4), 'u16'),
      cfg_data_crc: decodeField(pl.slice(6), 'u16'),
      cfg_rules_crc: decodeField(pl.slice(8), 'u16')
    };
  },
  25: function (bytes) {
    return { full_cfg: decodeFragment(bytes) };
  },
  26: function (bytes) {
    return { app_cfg: decodeFragment(bytes) };
  },
  27: function (bytes) {
    return { net_cfg: decodeFragment(bytes) };
  },
  28: function (bytes) {
    return { frame_cfg: decodeFragment(bytes) };
  },
  29: function (bytes) {
    return { data_cfg: decodeFragment(bytes) };
  },
  30: function (bytes) {
    return { rules_cfg: decodeFragment(bytes) };
  }
};

// Consume a variable-length frame-type encoding from the front of `bytes`,
// returning the absolute frame type (delta-added to `previousType`) or null.
function decodeFrameType(previousType, bytes) {
  var BLOCK = 0x1;
  var LAST_BLOCK = 0x2;
  var FTYPE_BITS = 6;
  var FTYPE_MASK = (1 << FTYPE_BITS) - 1;

  var frameTypeDelta = 0;

  while (bytes.length > 0) {
    var byte = bytes.shift();
    var type = byte >> FTYPE_BITS;
    var value = byte & FTYPE_MASK;

    if (type === BLOCK || type === LAST_BLOCK) {
      frameTypeDelta |= value;
      if (type === LAST_BLOCK) {
        return previousType + frameTypeDelta;
      }
      frameTypeDelta <<= FTYPE_BITS;
    } else {
      break;
    }
  }
  return null;
}

// Normalize an accumulated raw-frame object into the shared vocabulary.
// `raw` carries the union of all frames understood in the uplink.
function normalize(raw) {
  var data = {};
  var air = {};
  var motion = {};

  // air.temperature (°C) from current-state / last-temp frames.
  if (typeof raw.temperature === 'number') {
    air.temperature = round(raw.temperature, 2);
  }
  // air.relativeHumidity (%) from current-state / last-humid frames.
  if (typeof raw.humidity === 'number') {
    air.relativeHumidity = raw.humidity;
  }

  // action.motion: the device "moved" when its accelerometer reports a
  // non-idle activity state, or an impact / free-fall event.
  var motionDetected;
  if (typeof raw.activity_state === 'string') {
    motionDetected = raw.activity_state === 'LOW' || raw.activity_state === 'HIGH';
  }
  if (raw.impact_evnt) motionDetected = true;
  if (raw.free_fall_evnt) motionDetected = true;
  if (motionDetected !== undefined) {
    motion.detected = motionDetected;
  }
  // action.motion.count: cumulative impact events when reported.
  if (typeof raw.impact_cnt === 'number') {
    motion.count = raw.impact_cnt;
  } else if (typeof raw.impact_cnt_u16 === 'number') {
    motion.count = raw.impact_cnt_u16;
  }

  // battery (V) from dev-health (battery_mv is millivolts).
  if (typeof raw.battery_mv === 'number') {
    data.battery = round(raw.battery_mv / 1000, 3);
  }
  if (typeof raw.battery_mv_ema === 'number') {
    data.batteryMvEma = raw.battery_mv_ema;
  }

  // No-vocabulary device extras (camelCase, no vocab collisions).
  if (typeof raw.temperature_ema === 'number') {
    data.airTemperatureEma = round(raw.temperature_ema, 2);
  }
  if (typeof raw.humidity_ema === 'number') {
    data.airRelativeHumidityEma = raw.humidity_ema;
  }
  if (typeof raw.major_axis_orientation === 'string') {
    data.majorAxisOrientation = raw.major_axis_orientation;
  }
  if (typeof raw.activity_state === 'string') {
    data.activityState = raw.activity_state;
  }
  if (typeof raw.activity_s === 'number') data.activitySeconds = raw.activity_s;
  if (typeof raw.high_activity_s === 'number') data.highActivitySeconds = raw.high_activity_s;
  if (typeof raw.total_activity_s === 'number') data.totalActivitySeconds = raw.total_activity_s;
  if (typeof raw.free_fall_cnt === 'number') data.freeFallCount = raw.free_fall_cnt;
  if (typeof raw.mag_sw_cnt === 'number') data.magSwitchCount = raw.mag_sw_cnt;
  if (typeof raw.mag_sw_cnt_u8 === 'number') data.magSwitchCount = raw.mag_sw_cnt_u8;
  if (typeof raw.unix_time === 'number') data.time = utcIso(raw.unix_time);
  if (typeof raw.uptime_s === 'number') data.uptimeSeconds = raw.uptime_s;
  if (typeof raw.serial_number === 'string') data.serialNumber = raw.serial_number;

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }
  if (motion.detected !== undefined || motion.count !== undefined) {
    data.action = { motion: motion };
  }
  return data;
}

function decodeUplink(input) {
  var APP_PORT_MIN = 1;
  var APP_PORT_MAX = 223;

  if (input.fPort < APP_PORT_MIN || input.fPort > APP_PORT_MAX) {
    return { errors: ['fPort ' + input.fPort + ' outside application range 1..223'] };
  }

  var bytes = [input.fPort].concat(input.bytes);
  var raw = {};
  var frameType = 0;
  var recognized = false;

  while (bytes.length > 0) {
    frameType = decodeFrameType(frameType, bytes);
    if (frameType !== null && FRAME_DECODERS.hasOwnProperty(frameType)) {
      var frame = FRAME_DECODERS[frameType](bytes);
      for (var k in frame) {
        if (frame.hasOwnProperty(k)) raw[k] = frame[k];
      }
      recognized = true;
    } else {
      return { errors: ['Invalid key: ' + frameType] };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized MikroTik frames'] };
  }

  return { data: normalize(raw) };
}
