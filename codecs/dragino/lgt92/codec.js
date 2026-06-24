// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LGT-92 (LoRaWAN GPS tracker with a
// 3-axis accelerometer / motion detection).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lgt92.js, attributed in
// NOTICE); the field extraction (fixed big-endian binary layout) is reproduced
// faithfully, but the normalization below is authored for this module, never
// copied from the upstream output object.
//
// Wire format (fPort 2):
//   bytes 0-3   int32 BE latitude  * 1e-6 (signed decimal degrees, WGS84)
//   bytes 4-7   int32 BE longitude * 1e-6
//   byte  8     bit6 = ALARM/disturbance flag; bits0-5 high byte of battery mV
//   byte  9     low byte of battery mV  (BatV = ((b8 & 0x3f)<<8 | b9) / 1000)
//   byte 10     bits7-6 movement mode (Disable/Move/Collide/User);
//               bit5 = GPS-on (LON); bits0-4 firmware offset (+160)
//   bytes 11-14 (FW 1.5+) int16 BE roll, int16 BE pitch, * 0.01 deg
//   bytes 15-17 (GW 1.6)  hdop (b15/100), int16 BE altitude (* 0.01 m)
//
// Motion: movement mode "Move"/"Collide" => action.motion.detected = true.
//   "Disable" (detection off) and "User" (button-triggered uplink) are not
//   movement, so detected = false there; the raw mode is kept as `movement`.
// GPS: latitude/longitude are decoded on-device. They are suppressed (matching
//   upstream) when the GPS is off due to low battery (lat/lon read ~268 with
//   BatV <= 2.84) or when no fix was obtained (lat == 0 && lon == 0); a warning
//   is emitted and no position.* is published.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function int16(hi, lo) {
  var v = (hi << 8) | lo;
  if (v & 0x8000) {
    v = v - 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (!bytes || bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var warnings = [];
  var data = {};

  // bytes 0-3 / 4-7: signed int32 BE, micro-degrees.
  var latRaw = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  var lonRaw = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  var latitude = latRaw / 1000000;
  var longitude = lonRaw / 1000000;

  // byte 8: alarm flag + high 6 bits of battery; byte 9: low 8 bits.
  var alarm = !!(bytes[8] & (1 << 6));
  var battery = round((((bytes[8] & 0x3f) << 8) | bytes[9]) / 1000, 3);

  // byte 10: movement mode, GPS-on flag, firmware.
  var modes = ['Disable', 'Move', 'Collide', 'User'];
  var movement = modes[bytes[10] >> 6];
  var gpsOn = !!(bytes[10] & (1 << 5));
  var firmwareVersion = 160 + (bytes[10] & 0x1f);

  data.battery = battery;
  data.action = {
    motion: { detected: movement === 'Move' || movement === 'Collide' }
  };
  data.alarm = alarm;
  data.movement = movement;
  data.gpsOn = gpsOn;
  data.firmwareVersion = firmwareVersion;

  // GPS validity (faithful to upstream suppression rules).
  var gpsValid = true;
  if (battery <= 2.84 && latitude > 268 && longitude > 268) {
    gpsValid = false;
    warnings.push('GPS turned off because of low battery');
  } else if (latitude === 0 && longitude === 0) {
    gpsValid = false;
    warnings.push('GPS failed to obtain location');
  }

  if (gpsValid) {
    var position = {};
    if (latitude >= -90 && latitude <= 90) {
      position.latitude = latitude;
    }
    if (longitude >= -180 && longitude <= 180) {
      position.longitude = longitude;
    }
    if (position.latitude !== undefined || position.longitude !== undefined) {
      data.position = position;
    }
  }

  // Optional accelerometer / GW extras by frame length.
  if (bytes.length === 15 || bytes.length === 18) {
    data.roll = round(int16(bytes[11], bytes[12]) / 100, 2);
    data.pitch = round(int16(bytes[13], bytes[14]) / 100, 2);
  }
  if (bytes.length === 18) {
    data.hdop = round(bytes[15] / 100, 2);
    data.altitude = round(int16(bytes[16], bytes[17]) / 100, 2);
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lgt92";
  }
  return result;
}
