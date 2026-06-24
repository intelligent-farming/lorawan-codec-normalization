// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the dnt LW-DIS LoRaWAN distance sensor 1
// (time-of-flight distance node with an accelerometer-based sabotage/tamper
// detector and a temperature sensor, plus start-up, cyclic, button, downlink-
// error and configuration frames).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dnt/dnt-lw-dis-codec, attributed in
// NOTICE). The upstream field extraction (byte[0] packed voltage, then a stream
// of type-tagged records) is reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream decoded output).
//
// Frame layout: byte[0] is always the packed battery voltage
// (voltage_mV = byte[0] * 10 + 1500). The remaining bytes form one or more
// records, each tagged by a leading type byte:
//   type 0  POWER_ON   — start-up; optionally followed by a device-info block
//   type 1  CYCLE       \ ToF reading: 1-byte status + int16 distance (mm)
//   type 4  BUTTON      /
//   type 2  TEMP_NOTIF  — 1-byte notification flag + int16 temperature (0.1 °C)
//   type 3  SABOTAGE    — accelerometer tamper/movement event + orientation
//   type 5  DOWNLINK_ERR— int16 bitfield of rejected downlink fields
//   type 6  TEMPERATURE — int16 temperature (0.1 °C)
//   (GET_* configuration responses carry no normalized measurement.)
//
// Mapping to the vocabulary:
//   voltage (mV)                    -> battery (V, /1000)
//   SABOTAGE notification > 0       -> action.motion.detected = true
//   SABOTAGE notification = 0       -> action.motion.detected = false
//   temperature                     -> air.temperature (°C)
//   distance (mm)                   -> distanceMm (extra)
//   ToF status / orientation /
//     sabotage flag / reason /
//     temperature-notification flag -> camelCase extras
//
// The sabotage frame is the accelerometer-driven disturbance event: the device
// reports that it has been moved/tilted/tampered, which is the genuine motion
// event that places this device in the `motion` category. The raw distance and
// orientation are carried as extras (distance is not a motion signal).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian signed 16-bit.
function int16(b0, b1) {
  var v = ((b0 & 0xff) << 8) | (b1 & 0xff);
  if (v & 0x8000) {
    v = v - 0x10000;
  }
  return v;
}

// Big-endian unsigned 16-bit.
function uint16(b0, b1) {
  return ((b0 & 0xff) << 8) | (b1 & 0xff);
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }

  var data = {};
  var index = 0;

  // byte[0]: packed battery voltage in millivolts.
  data.battery = round(((bytes[index] & 0xff) * 10 + 1500) / 1000, 3);
  index += 1;

  var powerOn = false;
  var recordsSeen = 0;

  while (index < bytes.length) {
    var type = bytes[index] & 0xff;
    index += 1;

    if (type === 0) {
      // POWER_ON: optionally followed by a GET_DEVICE_INFO (255) block.
      powerOn = true;
      data.reason = 'Start-up';
      if (index < bytes.length && (bytes[index] & 0xff) === 255) {
        // device-info block: skip the info tag + 10 bytes (not normalized).
        index += 1;
        if (bytes.length < index + 10) {
          return { errors: ['power-on device-info block requires 10 bytes'] };
        }
        index += 10;
      }
    } else if (type === 1 || type === 4) {
      // CYCLE / BUTTON: 1-byte ToF status + int16 distance (mm).
      if (bytes.length < index + 3) {
        return { errors: ['distance record requires 3 bytes'] };
      }
      if (!powerOn) {
        data.reason = (type === 1) ? 'cycle' : 'button';
      }
      data.tofStatus = bytes[index] & 0xff;
      data.distanceMm = int16(bytes[index + 1], bytes[index + 2]);
      index += 3;
    } else if (type === 2) {
      // TEMPERATURE_NOTIFICATION: 1-byte flag + int16 temperature (0.1 °C).
      if (bytes.length < index + 3) {
        return { errors: ['temperature-notification record requires 3 bytes'] };
      }
      data.temperatureNotification = bytes[index] & 0xff;
      if (!data.air) { data.air = {}; }
      data.air.temperature = round(int16(bytes[index + 1], bytes[index + 2]) / 10, 1);
      index += 3;
    } else if (type === 3) {
      // SABOTAGE: accelerometer tamper/movement event + device orientation.
      if (bytes.length < index + 1) {
        return { errors: ['sabotage record requires 1 byte'] };
      }
      var flags = bytes[index] & 0xff;
      var notification = 0;
      if (flags & 0x40) {
        notification = 1;
      } else if (flags & 0x80) {
        notification = 2;
      }

      data.sabotageNotification = notification;
      data.action = { motion: { detected: notification > 0 } };

      var orientation = flags & ~0x40;
      var label = '';
      if (orientation & 0x01) {
        label = 'Up';
      } else if (orientation & 0x02) {
        label = 'Down';
      } else if (orientation & 0x04) {
        label = 'Sideways';
      }
      if (orientation & 0x08) {
        label = label + '|Tilted';
      }
      if (label !== '') {
        data.deviceOrientation = label;
      }
      index += 1;
    } else if (type === 5) {
      // DOWNLINK_ERROR: int16 bitfield of rejected downlink field indexes.
      if (bytes.length < index + 2) {
        return { errors: ['downlink-error record requires 2 bytes'] };
      }
      var errorField = uint16(bytes[index], bytes[index + 1]);
      var rejected = [];
      for (var i = 0; i < 16; i++) {
        if (errorField & (1 << i)) {
          rejected.push(i);
        }
      }
      data.downlinkErrorFields = rejected;
      index += 2;
    } else if (type === 6) {
      // TEMPERATURE: int16 temperature (0.1 °C).
      if (bytes.length < index + 2) {
        return { errors: ['temperature record requires 2 bytes'] };
      }
      if (!data.air) { data.air = {}; }
      data.air.temperature = round(int16(bytes[index], bytes[index + 1]) / 10, 1);
      index += 2;
    } else {
      // GET_* configuration responses and unknown types are not normalized.
      break;
    }

    recordsSeen += 1;
  }

  if (recordsSeen === 0) {
    return { errors: ['unsupported message type (expected 0, 1, 2, 3, 4, 5 or 6)'] };
  }

  return { data: data };
}
