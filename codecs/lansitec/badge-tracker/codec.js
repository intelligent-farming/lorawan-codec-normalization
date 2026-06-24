// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Lansitec Badge Tracker (LoRaWAN personnel /
// asset badge: GNSS position fix, BLE-beacon positioning scans, a heartbeat with
// battery / link quality / GPS state / movement / charge state, a register
// (configuration) frame, and an SOS / fall alarm).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/lansitec/badge-tracker.js, attributed
// in NOTICE). The upstream field extraction (mode/type-framed binary layout) is
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream normalizeUplink output).
//
// Lansitec frames are self-describing: the high nibble of bytes[0] is the
// message type. Five types are defined:
//   0x1 Register      — device configuration (no measurement)            -> error
//   0x2 Heartbeat     — battery %, RSSI, SNR, GPS state, movement, charge -> measurement
//   0x3 GNSSPosition  — on-device GNSS fix: IEEE-754 lon/lat + UTC time   -> position
//   0x7 Beacon        — BLE beacon scan list (cloud-solved, not a fix)    -> extras
//   0x8 Alarm         — SOS / fall alarm                                  -> measurement
//
// GNSSPosition (type 0x3) is the only genuine on-device latitude/longitude fix,
// so it satisfies the gps-tracker category. Longitude and latitude are 32-bit
// big-endian IEEE-754 floats (bytes 1-4 = longitude, bytes 5-8 = latitude);
// bytes 9-12 are a big-endian uint32 of UTC epoch seconds.
//
// NOTE — upstream float bug: the upstream `hex2float` builds the mantissa as
// `1 + (frac / 0x7fffff)` (dividing by 0x7fffff instead of 0x800000), which
// inflates every non-zero-mantissa coordinate by a small amount (e.g. 116.0
// decodes as 116.0000062). We decode IEEE-754 correctly here (divisor 0x800000)
// and round to 7 decimals (GNSS resolution). Out-of-range coordinates
// (|lat| > 90, |lon| > 180) are suppressed, guarding against a malformed frame.
//
// The Beacon frame carries only BLE major/minor/RSSI tuples — positioning is
// solved off-device, so we emit the scan list as the `bleBeacons` extra and
// never synthesize a position.* from it.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Decode a 32-bit big-endian IEEE-754 float from four byte values.
function floatBE(b0, b1, b2, b3) {
  var bits = ((b0 & 0xff) * 16777216) + ((b1 & 0xff) * 65536) + ((b2 & 0xff) * 256) + (b3 & 0xff);
  var sign = (bits & 0x80000000) ? -1 : 1;
  var exponent = (bits >>> 23) & 0xff;
  var frac = bits & 0x7fffff;
  if (exponent === 0) {
    if (frac === 0) {
      return sign * 0;
    }
    return sign * frac * Math.pow(2, -149);
  }
  if (exponent === 0xff) {
    return frac === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + frac / 0x800000) * Math.pow(2, exponent - 127);
}

function uint32BE(b0, b1, b2, b3) {
  return ((b0 & 0xff) * 16777216) + ((b1 & 0xff) * 65536) + ((b2 & 0xff) * 256) + (b3 & 0xff);
}

function decodeHeartbeat(bytes) {
  var data = {};

  data.batteryPercent = bytes[1] & 0xff;
  data.rssi = -(bytes[2] & 0xff);
  data.snr = round(((bytes[3] << 8) | (bytes[4] & 0xff)) * 0.01, 2);

  var gpsStateCode = (bytes[5] >> 4) & 0x0f;
  var gpsStates = {
    0: 'off',
    1: 'boot',
    2: 'locating',
    3: 'located',
    9: 'noSignal'
  };
  data.gpsState = gpsStates[gpsStateCode] !== undefined ? gpsStates[gpsStateCode] : gpsStateCode;

  var moving = (bytes[5] & 0x0f) === 0x01;
  data.action = { motion: { detected: moving } };

  var chargeCode = (bytes[6] >> 4) & 0x0f;
  var chargeStates = {
    0: 'disconnected',
    5: 'charging',
    6: 'complete'
  };
  data.chargeState = chargeStates[chargeCode] !== undefined ? chargeStates[chargeCode] : chargeCode;

  return { data: data };
}

function decodeGNSSPosition(bytes) {
  var data = {};
  var warnings = [];

  var lon = round(floatBE(bytes[1], bytes[2], bytes[3], bytes[4]), 7);
  var lat = round(floatBE(bytes[5], bytes[6], bytes[7], bytes[8]), 7);

  var position = {};
  if (lat >= -90 && lat <= 90) {
    position.latitude = lat;
  }
  if (lon >= -180 && lon <= 180) {
    position.longitude = lon;
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  } else {
    warnings.push('position out of range');
  }

  var epoch = uint32BE(bytes[9], bytes[10], bytes[11], bytes[12]);
  data.time = new Date(epoch * 1000).toISOString();

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function pad4(s) {
  return ('0000' + s).slice(-4);
}

function decodeBeacon(bytes) {
  var data = {};
  var count = bytes[0] & 0x0f;

  data.movementLevel = bytes[1] & 0xff;

  var beacons = [];
  for (var i = 0; i < count; i++) {
    var base = 6 + 5 * i;
    if (base + 4 >= bytes.length) {
      break;
    }
    beacons.push({
      major: pad4((((bytes[base] << 8) & 0xff00) | (bytes[base + 1] & 0xff)).toString(16).toUpperCase()),
      minor: pad4((((bytes[base + 2] << 8) & 0xff00) | (bytes[base + 3] & 0xff)).toString(16).toUpperCase()),
      rssi: (bytes[base + 4] & 0xff) - 256
    });
  }
  data.bleBeacons = beacons;

  return { data: data };
}

function decodeAlarm(bytes) {
  var data = {};
  var alarmCode = bytes[1] & 0xff;
  var alarms = {
    1: 'sos',
    2: 'fall'
  };
  data.alarm = alarms[alarmCode] !== undefined ? alarms[alarmCode] : alarmCode;
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }

  var messageType = (bytes[0] >> 4) & 0x0f;

  if (messageType === 0x3) {
    if (bytes.length < 13) {
      return { errors: ['GNSSPosition frame requires 13 bytes'] };
    }
    return decodeGNSSPosition(bytes);
  }
  if (messageType === 0x2) {
    if (bytes.length < 7) {
      return { errors: ['heartbeat frame requires 7 bytes'] };
    }
    return decodeHeartbeat(bytes);
  }
  if (messageType === 0x7) {
    if (bytes.length < 2) {
      return { errors: ['beacon frame requires at least 2 bytes'] };
    }
    return decodeBeacon(bytes);
  }
  if (messageType === 0x8) {
    if (bytes.length < 2) {
      return { errors: ['alarm frame requires 2 bytes'] };
    }
    return decodeAlarm(bytes);
  }
  if (messageType === 0x1) {
    return { errors: ['register frame carries device configuration, not a measurement'] };
  }

  return { errors: ['unsupported message type (high nibble of byte 0)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "lansitec";
    result.data.model = "badge-tracker";
  }
  return result;
}
