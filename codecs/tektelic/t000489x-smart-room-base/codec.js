// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Tektelic T000489x COMFORT Smart Room Sensor
// (PIR Base).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on application fPort 10) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_smart_room_sensor_pir_base.js, attributed in NOTICE). The upstream
// normalizeUplink is NOT copied: it forces the raw reed_state number into the
// contactState enum, drops the numeric light_intensity channel, and never maps
// moisture; this codec authors those mappings directly.
//
// Each TLV field is keyed by a two-byte [channel, type] header on fPort 10,
// followed by a fixed-width big-endian value. Battery is reported in volts
// (signed16 * 0.01), so it maps to the vocabulary `battery` (V) directly.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(bytes, i) {
  return bytes[i] & 0xff;
}

function u16be(bytes, i) {
  return ((bytes[i] << 8) | (bytes[i + 1] & 0xff)) & 0xffff;
}

function s16be(bytes, i) {
  var v = u16be(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 10) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected application fPort 10)'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var soil = {};
  var motion = {};
  var extras = {};

  var i = 0;
  while (i + 1 < bytes.length) {
    var ch = bytes[i];
    var ty = bytes[i + 1];

    // 0x00 0xFF — battery voltage: signed16 BE * 0.01 V
    if (ch === 0x00 && ty === 0xff) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated battery field at offset ' + i] };
      }
      data.battery = round(s16be(bytes, i + 2) * 0.01, 2);
      i += 4;

    // 0x01 0x00 — reed (contact) state: u8
    } else if (ch === 0x01 && ty === 0x00) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated reed state field at offset ' + i] };
      }
      data.action = data.action || {};
      data.action.contactState = u8(bytes, i + 2) === 0 ? 'closed' : 'open';
      i += 3;

    // 0x02 0x00 — light detected flag (categorical): u8 -> extra
    } else if (ch === 0x02 && ty === 0x00) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated light detected field at offset ' + i] };
      }
      extras.lightDetected = u8(bytes, i + 2) !== 0;
      i += 3;

    // 0x03 0x67 — ambient temperature: signed16 BE * 0.1 C
    } else if (ch === 0x03 && ty === 0x67) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated ambient temperature field at offset ' + i] };
      }
      air.temperature = round(s16be(bytes, i + 2) * 0.1, 1);
      i += 4;

    // 0x04 0x68 — relative humidity: u8 * 0.5 %
    } else if (ch === 0x04 && ty === 0x68) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated relative humidity field at offset ' + i] };
      }
      air.relativeHumidity = round(u8(bytes, i + 2) * 0.5, 1);
      i += 3;

    // 0x05 0x02 — impact magnitude: u16 BE * 0.001 g -> extra
    } else if (ch === 0x05 && ty === 0x02) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated impact magnitude field at offset ' + i] };
      }
      extras.impactMagnitude = round(u16be(bytes, i + 2) * 0.001, 3);
      i += 4;

    // 0x07 0x71 — acceleration x/y/z: signed16 BE * 0.001 g each -> extras
    } else if (ch === 0x07 && ty === 0x71) {
      if (i + 7 >= bytes.length) {
        return { errors: ['truncated acceleration field at offset ' + i] };
      }
      extras.accelerationX = round(s16be(bytes, i + 2) * 0.001, 3);
      extras.accelerationY = round(s16be(bytes, i + 4) * 0.001, 3);
      extras.accelerationZ = round(s16be(bytes, i + 6) * 0.001, 3);
      i += 8;

    // 0x08 0x04 — reed count: u16 BE -> extra
    } else if (ch === 0x08 && ty === 0x04) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated reed count field at offset ' + i] };
      }
      extras.reedCount = u16be(bytes, i + 2);
      i += 4;

    // 0x09 0x00 — moisture: u8 % -> soil.moisture
    } else if (ch === 0x09 && ty === 0x00) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated moisture field at offset ' + i] };
      }
      soil.moisture = u8(bytes, i + 2);
      i += 3;

    // 0x0A 0x00 — motion (PIR) event state: u8 -> action.motion.detected
    } else if (ch === 0x0a && ty === 0x00) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated motion state field at offset ' + i] };
      }
      motion.detected = u8(bytes, i + 2) !== 0;
      i += 3;

    // 0x0B 0x67 — MCU temperature: signed16 BE * 0.1 C -> extra
    } else if (ch === 0x0b && ty === 0x67) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated mcu temperature field at offset ' + i] };
      }
      extras.mcuTemperature = round(s16be(bytes, i + 2) * 0.1, 1);
      i += 4;

    // 0x0C 0x00 — impact alarm: u8 -> extra (boolean)
    } else if (ch === 0x0c && ty === 0x00) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated impact alarm field at offset ' + i] };
      }
      extras.impactAlarm = u8(bytes, i + 2) !== 0;
      i += 3;

    // 0x0D 0x04 — motion (PIR) event count: u16 BE -> action.motion.count
    } else if (ch === 0x0d && ty === 0x04) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated motion count field at offset ' + i] };
      }
      motion.count = u16be(bytes, i + 2);
      i += 4;

    // 0x0E 0x00 — external connector state: u8 -> extra (boolean)
    } else if (ch === 0x0e && ty === 0x00) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated external connector state field at offset ' + i] };
      }
      extras.extConnectorState = u8(bytes, i + 2) !== 0;
      i += 3;

    // 0x0F 0x04 — external connector count: u16 BE -> extra
    } else if (ch === 0x0f && ty === 0x04) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated external connector count field at offset ' + i] };
      }
      extras.extConnectorCount = u16be(bytes, i + 2);
      i += 4;

    // 0x10 0x02 — light intensity (numeric): u8 lux -> air.lightIntensity
    } else if (ch === 0x10 && ty === 0x02) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated light intensity field at offset ' + i] };
      }
      air.lightIntensity = u8(bytes, i + 2);
      i += 3;

    // 0x11 0x02 — external connector analog: u16 BE * 0.001 V -> extra
    } else if (ch === 0x11 && ty === 0x02) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated external connector analog field at offset ' + i] };
      }
      extras.extConnectorAnalog = round(u16be(bytes, i + 2) * 0.001, 3);
      i += 4;

    } else {
      return { errors: ['unknown channel/type 0x' + ch.toString(16) + ' 0x' + ty.toString(16) + ' at offset ' + i] };
    }
  }

  if (i !== bytes.length) {
    return { errors: ['trailing byte at offset ' + i] };
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined || air.lightIntensity !== undefined) {
    data.air = air;
  }
  if (soil.moisture !== undefined) {
    data.soil = soil;
  }
  if (motion.detected !== undefined || motion.count !== undefined) {
    data.action = data.action || {};
    data.action.motion = motion;
  }

  var k;
  for (k in extras) {
    if (extras.hasOwnProperty(k)) {
      data[k] = extras[k];
    }
  }

  var hasData = false;
  for (k in data) {
    if (data.hasOwnProperty(k)) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    return { errors: ['no recognized measurement fields'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t000489x-smart-room-base";
  }
  return result;
}
