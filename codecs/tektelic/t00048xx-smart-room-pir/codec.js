// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic Smart Room Sensor - PIR
// (T00048xx). Reports ambient temperature, relative humidity, ambient light,
// and PIR motion (state + count); the same base also exposes reed/contact,
// accelerometer, impact, and external-connector channels which are surfaced as
// camelCase extras.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on fPort 10, big-endian fields) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_smart_room_sensor_pir_base.js, attributed in NOTICE). Author the
// normalization here; upstream normalizeUplink is NOT copied.
//
// Mapping notes:
//   - battery_voltage (channel 0x00) is already volts (signed16 * 0.01) -> the
//     vocabulary `battery` field, not batteryPercent.
//   - light_intensity (channel 0x10) is a numeric 0-255 ambient-light reading,
//     mapped to air.lightIntensity per the category contract. It is a relative
//     scale, not calibrated lux; consumers should treat the magnitude as
//     device-specific.
//   - light_detected (channel 0x02) is a categorical light/dark boolean and is
//     emitted as the extra `lightDetected`, not pushed into air.lightIntensity.
//   - motion_event_state (channel 0x0A) -> action.motion.detected (boolean);
//     motion_event_count (channel 0x0D) -> action.motion.count.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first), matching the
// upstream apply_data_type("unsigned") accumulation.
function uintBE(bytes, offset, length) {
  var out = 0;
  for (var i = 0; i < length; i++) {
    out = out * 256 + (bytes[offset + i] & 0xff);
  }
  return out;
}

// Big-endian signed (two's complement) integer from a byte slice.
function intBE(bytes, offset, length) {
  var out = uintBE(bytes, offset, length);
  var max = Math.pow(2, 8 * length);
  if (out >= max / 2) {
    out -= max;
  }
  return out;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected data uplink on fPort 10)'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var extras = {};
  var i = 0;

  while (i < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xff) {
      // Battery voltage: signed16 BE * 0.01 V.
      data.battery = round(intBE(bytes, i + 2, 2) * 0.01, 2);
      i += 4;
    } else if (channel === 0x01 && type === 0x00) {
      // Reed switch state (door/window variant of the base): 0/1 -> extra.
      extras.reedState = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x02 && type === 0x00) {
      // Categorical light/dark detection -> extra (not numeric lux).
      extras.lightDetected = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x03 && type === 0x67) {
      // Ambient temperature: signed16 BE * 0.1 C.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x04 && type === 0x68) {
      // Relative humidity: uint8 * 0.5 %.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x05 && type === 0x02) {
      // Accelerometer impact magnitude: uint16 BE * 0.001 g -> extra.
      extras.impactMagnitude = round(uintBE(bytes, i + 2, 2) * 0.001, 3);
      i += 4;
    } else if (channel === 0x07 && type === 0x71) {
      // Acceleration vector x/y/z: signed16 BE * 0.001 g -> extra.
      extras.accelerationX = round(intBE(bytes, i + 2, 2) * 0.001, 3);
      extras.accelerationY = round(intBE(bytes, i + 4, 2) * 0.001, 3);
      extras.accelerationZ = round(intBE(bytes, i + 6, 2) * 0.001, 3);
      i += 8;
    } else if (channel === 0x08 && type === 0x04) {
      // Reed switch event count: uint16 BE -> extra.
      extras.reedCount = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x09 && type === 0x00) {
      // Moisture-pad raw reading: uint8 -> extra (device-specific scale).
      extras.moisture = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x0a && type === 0x00) {
      // PIR motion state: uint8 -> action.motion.detected (boolean).
      motion.detected = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x0b && type === 0x67) {
      // MCU temperature: signed16 BE * 0.1 C -> extra (not ambient air temp).
      extras.mcuTemperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x0c && type === 0x00) {
      // Accelerometer impact alarm flag: uint8 -> extra.
      extras.impactAlarm = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x0d && type === 0x04) {
      // PIR motion event count: uint16 BE -> action.motion.count.
      motion.count = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x0e && type === 0x00) {
      // External connector digital state: uint8 -> extra.
      extras.extConnectorState = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x0f && type === 0x04) {
      // External connector event count: uint16 BE -> extra.
      extras.extConnectorCount = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x10 && type === 0x02) {
      // Ambient light intensity: uint8 (0-255 relative scale) -> air.lightIntensity.
      air.lightIntensity = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x11 && type === 0x02) {
      // External connector analog input: uint16 BE * 0.001 V -> extra.
      extras.extConnectorAnalog = round(uintBE(bytes, i + 2, 2) * 0.001, 3);
      i += 4;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' +
            ('0' + channel.toString(16)).slice(-2) +
            '/0x' +
            ('0' + (type === undefined ? 0 : type).toString(16)).slice(-2) +
            ' at byte ' +
            i,
        ],
      };
    }
  }

  if (air.temperature !== undefined ||
      air.relativeHumidity !== undefined ||
      air.lightIntensity !== undefined) {
    data.air = air;
  }
  if (motion.detected !== undefined || motion.count !== undefined) {
    data.action = { motion: motion };
  }

  var extraKeys = [];
  var k;
  for (k in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, k)) {
      extraKeys.push(k);
    }
  }
  for (var j = 0; j < extraKeys.length; j++) {
    data[extraKeys[j]] = extras[extraKeys[j]];
  }

  var hasData = false;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    return { errors: ['no decodable measurements in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t00048xx-smart-room-pir";
  }
  return result;
}
