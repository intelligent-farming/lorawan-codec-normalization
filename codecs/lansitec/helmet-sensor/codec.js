// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Lansitec Helmet Sensor (LoRaWAN safety-helmet
// wearable: on-device GNSS position fix, BLE positioning/asset beacon scans, a
// heartbeat with battery / link quality / GPS+BLE state / wear+charge timers /
// movement, and an SOS / fall / danger-area / search alarm).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/lansitec/helmet-sensor.js, attributed
// in NOTICE). The upstream field extraction (mode/type-framed binary layout) is
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream per-message Object output).
//
// Lansitec frames are self-describing: the high nibble of bytes[0] is the
// message type. Five types are defined:
//   0x1 Register     — device configuration (no measurement)              -> error
//   0x2 Heartbeat    — battery %, RSSI, SNR, GPS/BLE state, timers, move   -> measurement
//   0x3 GNSSPosition — on-device GNSS fix: IEEE-754 lon/lat + UTC time     -> position
//   0x7 Beacon       — BLE beacon scan list (cloud-solved, not a fix)      -> extras
//   0x8 Alarm        — SOS / fall / danger-area / search alarm             -> measurement
//
// GNSSPosition (type 0x3) is the only genuine on-device latitude/longitude fix,
// so it satisfies the gps-tracker category. Its frame is:
//   byte 0      : type nibble + gpsState (bit 3) + wearState (bit 0)
//   bytes 1-4   : raw barometric/pressure word (no documented hPa scaling)
//   bytes 5-8   : longitude, 32-bit big-endian IEEE-754 float
//   bytes 9-12  : latitude,  32-bit big-endian IEEE-754 float
//   bytes 13-16 : UTC epoch seconds, 32-bit big-endian uint
// so the frame requires 17 bytes.
//
// NOTE — upstream float bug: the upstream `hex2float` builds the mantissa as
// `1 + (frac / 0x7fffff)` (dividing by 0x7fffff instead of 0x800000), which
// inflates every non-zero-mantissa coordinate by a small amount (e.g. 116.0
// decodes as 116.0000062). We decode IEEE-754 correctly here (divisor 0x800000)
// and round to 7 decimals (GNSS resolution). Out-of-range coordinates
// (|lat| > 90, |lon| > 180) are suppressed, guarding against a malformed frame.
//
// NOTE — upstream UTC bug: upstream builds the fix timestamp as
//   new Date((unixSeconds + 8*60*60) * 1000)
// shifting the actual instant forward by 8 hours (a +8h CST offset mistakenly
// applied to an already-UTC epoch). We emit the true UTC instant.
//
// The Beacon frame carries only BLE major/minor/RSSI tuples — positioning is
// solved off-device, so we emit the scan list as the `bleBeacons` extra and
// never synthesize a position.* from it. A Fall alarm and a non-zero heartbeat
// movement level are surfaced as action.motion.detected (motion category).

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

function pad4(s) {
  return ('0000' + s).slice(-4);
}

function decodeHeartbeat(bytes) {
  var data = {};

  data.batteryPercent = bytes[1] & 0xff;
  data.rssi = -(bytes[2] & 0xff);
  data.snr = round(((bytes[3] << 8) | (bytes[4] & 0xff)) * 0.01, 2);
  data.bleState = bytes[5] & 0xff;
  data.gpsState = bytes[6] & 0xff;
  data.chargeSeconds = (bytes[7] & 0xff) * 30;
  data.wearSeconds = (bytes[8] & 0xff) * 30;

  var moveLevel = (bytes[9] >> 4) & 0x0f;
  data.movementLevel = moveLevel;
  data.action = { motion: { detected: moveLevel > 0 } };

  return { data: data };
}

function decodeGNSSPosition(bytes) {
  var data = {};
  var warnings = [];

  data.gpsFixSuccess = ((bytes[0] >> 3) & 0x01) === 0x00;
  data.wearing = (bytes[0] & 0x01) === 0x01;

  // Bytes 1-4 are a raw barometric word with no documented hPa scaling; emit it
  // verbatim as an extra rather than forcing the bounded air.pressure key.
  data.pressureRaw = uint32BE(bytes[1], bytes[2], bytes[3], bytes[4]);

  var lon = round(floatBE(bytes[5], bytes[6], bytes[7], bytes[8]), 7);
  var lat = round(floatBE(bytes[9], bytes[10], bytes[11], bytes[12]), 7);

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

  var epoch = uint32BE(bytes[13], bytes[14], bytes[15], bytes[16]);
  data.time = new Date(epoch * 1000).toISOString();

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function decodeBeacon(bytes) {
  var data = {};

  data.wearing = (bytes[0] & 0x01) === 0x01;
  data.pressureRaw = uint32BE(bytes[1], bytes[2], bytes[3], bytes[4]);

  var posLength = bytes[5] & 0x0f;
  var assetLength = bytes[6] & 0x0f;

  var posBeacons = [];
  var i;
  for (i = 0; i < posLength; i++) {
    var pbase = 7 + 5 * i;
    if (pbase + 4 >= bytes.length) {
      break;
    }
    posBeacons.push({
      major: pad4((((bytes[pbase] << 8) & 0xff00) | (bytes[pbase + 1] & 0xff)).toString(16).toUpperCase()),
      minor: pad4((((bytes[pbase + 2] << 8) & 0xff00) | (bytes[pbase + 3] & 0xff)).toString(16).toUpperCase()),
      rssi: (bytes[pbase + 4] & 0xff) - 256
    });
  }

  var assetBeacons = [];
  var assetOffset = 7 + posLength * 5;
  for (i = 0; i < assetLength; i++) {
    var abase = assetOffset + 5 * i;
    if (abase + 4 >= bytes.length) {
      break;
    }
    assetBeacons.push({
      major: pad4((((bytes[abase] << 8) & 0xff00) | (bytes[abase + 1] & 0xff)).toString(16).toUpperCase()),
      minor: pad4((((bytes[abase + 2] << 8) & 0xff00) | (bytes[abase + 3] & 0xff)).toString(16).toUpperCase()),
      rssi: (bytes[abase + 4] & 0xff) - 256
    });
  }

  data.bleBeacons = posBeacons;
  data.bleAssetBeacons = assetBeacons;

  return { data: data };
}

function decodeAlarm(bytes) {
  var data = {};
  var alarmCode = bytes[1] & 0xff;
  var alarms = {
    1: 'sos',
    2: 'fall',
    3: 'dangerArea',
    4: 'search'
  };
  data.alarm = alarms[alarmCode] !== undefined ? alarms[alarmCode] : alarmCode;
  // A fall is a genuine motion event; surface it on the motion vocabulary key.
  data.action = { motion: { detected: alarmCode === 2 } };
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }

  var messageType = (bytes[0] >> 4) & 0x0f;

  if (messageType === 0x3) {
    if (bytes.length < 17) {
      return { errors: ['GNSSPosition frame requires 17 bytes'] };
    }
    return decodeGNSSPosition(bytes);
  }
  if (messageType === 0x2) {
    if (bytes.length < 10) {
      return { errors: ['heartbeat frame requires 10 bytes'] };
    }
    return decodeHeartbeat(bytes);
  }
  if (messageType === 0x7) {
    if (bytes.length < 7) {
      return { errors: ['beacon frame requires at least 7 bytes'] };
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
    result.data.model = "helmet-sensor";
  }
  return result;
}
