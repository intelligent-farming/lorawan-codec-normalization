// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Abeeway Geolocation Module / Micro Tracker
// (multi-technology asset tracker: GPS/GNSS, WiFi/BLE scan geolocation, a
// 3-axis accelerometer for motion/shock, and a temperature sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Abeeway "Asset Tracker 3" uplink protocol on fPort 19) was ported
// from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/abeeway/asset-tracker-3.js, codecId
// asset-tracker-3-codec, attributed in NOTICE). The upstream field extraction
// (bit slicing of the common header, the position header, and the MT3333 GNSS
// fix block) is reproduced faithfully; only the JSON shape is re-authored to
// the normalized vocabulary (never the upstream decodeUplink output, which
// nests everything under header/position/notification).
//
// Common header (bytes 0..3, every uplink):
//   byte0  bit7 multiFrame | bit6 sos | bits5-3 messageType | bits2-0 ackToken
//          messageType: 1 NOTIFICATION, 2 POSITION, 3 QUERY, 4 RESPONSE,
//          5 TELEMETRY
//   byte1  bits6-0 batteryLevel: 0 = CHARGING, 127 = UNKNOWN, else 1..100 %
//   byte2..3  16-bit half-day timestamp (relative; we do NOT attempt the
//          upstream recvTime reconstruction — it depends on a gateway receive
//          time we cannot trust, so a measurement `time` is omitted).
//
// POSITION (messageType 2): position header at byte 4 (non-multiframe):
//   byte4  bit7 motion | bits6-5 status (0 SUCCESS) | bits3-0 positionType
//          positionType: 3 WIFI, 4-9 BLE scans, 10 GNSS, 11 AIDED_GNSS
//          bit7 motion flag -> action.motion.detected
//   byte5  bits3-0 motion counter -> action.motion.count ; byte6/byte7 trigger
//          bitmap (ignored)
//   body starts at byte 8.
//   GNSS body (MT3333 fix), big-endian:
//     [0..4)  latitude  = twoComplement(int32) / 1e7   -> position.latitude
//     [4..8)  longitude = twoComplement(int32) / 1e7   -> position.longitude
//     [8..10) altitude  (m)                            -> altitudeM (extra)
//     [10..12) course over ground (1/100 deg)          -> courseDeg (extra)
//     [12..14) speed over ground (cm/s) -> m/s          -> speedMS (extra)
//     [14]    EHPE (m, bucketed when > 250)            -> gpsAccuracyM (extra)
//     [15]    bits7-5 fixQuality | bits3-0 satellites   -> extras
//   WIFI body: repeated 7-byte AP records (6 MAC bytes + signed int8 RSSI dBm).
//   BLE body: repeated 7-byte MAC records (6 MAC bytes + signed int8 RSSI).
//   WiFi/BLE scans do not carry a solved lat/lon on-device, so they are emitted
//   only as the camelCase extras wifiScan / bleScan (coordinates are solved
//   off-device by the network).
//
// NOTIFICATION (messageType 1): byte4 high nibble = class, low nibble = type.
//   class 2 TEMPERATURE: byte5 signed int8 °C   -> air.temperature
//   class 3 ACCELEROMETER (MOTION_START/MOTION_END/SHOCK)
//                                               -> action.motion.detected=true
//
// batteryLevel is a PERCENTAGE, not a voltage, so it maps to the camelCase
// extra batteryPercent (vocabulary `battery` is volts). CHARGING/UNKNOWN states
// are surfaced as the extra batteryState instead of a numeric percent.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function byteHex(b) {
  var h = (b & 0xff).toString(16);
  if (h.length < 2) {
    h = '0' + h;
  }
  return h;
}

// 32-bit two's-complement, matching the upstream util.twoComplement.
function toSigned32(num) {
  if (num > 0x7fffffff) {
    num -= 0x100000000;
  }
  return num;
}

// 8-bit signed (upstream util.convertNegativeInt(byte, 1)).
function toSigned8(b) {
  b = b & 0xff;
  if (b > 0x7f) {
    b -= 0x100;
  }
  return b;
}

function uint32be(bytes, off) {
  return (
    ((bytes[off] & 0xff) * 0x1000000) +
    ((bytes[off + 1] & 0xff) << 16) +
    ((bytes[off + 2] & 0xff) << 8) +
    (bytes[off + 3] & 0xff)
  );
}

function uint16be(bytes, off) {
  return ((bytes[off] & 0xff) << 8) + (bytes[off + 1] & 0xff);
}

function batteryFromHeader(bytes, data) {
  var value = bytes[1] & 0x7f;
  if (value === 0) {
    data.batteryState = 'charging';
  } else if (value === 127) {
    data.batteryState = 'unknown';
  } else {
    data.batteryPercent = value;
  }
}

function macString(bytes, base) {
  return (
    byteHex(bytes[base]) + ':' +
    byteHex(bytes[base + 1]) + ':' +
    byteHex(bytes[base + 2]) + ':' +
    byteHex(bytes[base + 3]) + ':' +
    byteHex(bytes[base + 4]) + ':' +
    byteHex(bytes[base + 5])
  );
}

// MT3333 GNSS fix — ported from the upstream gnssFix slicing.
function decodeGnss(body, data) {
  if (body.length < 16) {
    return { errors: ['GNSS position frame truncated (need 16 bytes of fix data)'] };
  }

  var lat = toSigned32(uint32be(body, 0)) / 10000000;
  var lon = toSigned32(uint32be(body, 4)) / 10000000;

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { errors: ['GNSS fix out of range (latitude/longitude)'] };
  }

  var position = {};
  position.latitude = round(lat, 7);
  position.longitude = round(lon, 7);
  data.position = position;

  data.altitudeM = uint16be(body, 8);
  data.courseDeg = round(uint16be(body, 10) / 100, 2);
  // Speed over ground is reported in cm/s; expose m/s as an extra.
  data.speedMS = round(uint16be(body, 12) / 100, 2);

  var ehpe = body[14] & 0xff;
  if (ehpe <= 250) {
    data.gpsAccuracyM = ehpe;
  } else {
    data.gpsAccuracyBucket = '>250';
  }

  var quality = (body[15] >> 5) & 0x07;
  if (quality === 1) {
    data.fixQuality = 'valid';
  } else if (quality === 2) {
    data.fixQuality = 'fix2D';
  } else if (quality === 3) {
    data.fixQuality = 'fix3D';
  } else {
    data.fixQuality = 'invalid';
  }
  data.satellites = body[15] & 0x0f;

  return null;
}

// Repeated 7-byte scan records (6 MAC bytes + signed int8 RSSI), shared by the
// upstream WiFi and BLE-MAC decoders.
function decodeMacScan(body) {
  var entries = [];
  var i = 0;
  while (body.length >= 7 * (i + 1)) {
    var base = i * 7;
    entries.push({ mac: macString(body, base), rssi: toSigned8(body[base + 6]) });
    i++;
  }
  return entries;
}

function decodePosition(bytes, multiFrame) {
  var startingByte = multiFrame ? 5 : 4;
  if (bytes.length < startingByte + 4) {
    return { errors: ['position frame truncated'] };
  }

  var data = {};
  batteryFromHeader(bytes, data);

  var hdr = bytes[startingByte] & 0xff;
  var statusValue = (hdr >> 5) & 0x03;
  var typeValue = hdr & 0x0f;

  // Position-header "motion" flag (bit 7) + 4-bit motion counter -> normalized
  // action.motion (mirrors the Abeeway Compact Tracker sibling: the moving flag
  // maps to action.motion.detected, the cumulative counter to action.motion.count).
  data.action = {
    motion: {
      detected: ((hdr >> 7) & 0x01) === 1,
      count: bytes[startingByte + 1] & 0x0f
    }
  };

  var statusNames = ['success', 'timeout', 'failure', 'notSolvable'];
  data.positionStatus = statusNames[statusValue];

  // Only SUCCESS (0) / NOT_SOLVABLE (3) carry location payloads upstream.
  if (statusValue !== 0 && statusValue !== 3) {
    return { errors: ['position frame reports no fix (status ' + data.positionStatus + ')'] };
  }

  // Body follows the 4-byte position header.
  var body = bytes.slice(startingByte + 4);

  if (typeValue === 10 || typeValue === 11) {
    data.positionType = typeValue === 10 ? 'gnss' : 'aidedGnss';
    var err = decodeGnss(body, data);
    if (err) {
      return err;
    }
    return { data: data };
  }

  if (typeValue === 3) {
    data.positionType = 'wifi';
    data.wifiScan = decodeMacScan(body);
    return { data: data };
  }

  if (typeValue >= 4 && typeValue <= 9) {
    data.positionType = 'bleScan';
    data.bleScan = decodeMacScan(body);
    return { data: data };
  }

  return { errors: ['unsupported position type (' + typeValue + ')'] };
}

function decodeNotification(bytes) {
  if (bytes.length < 5) {
    return { errors: ['notification frame truncated'] };
  }

  var data = {};
  batteryFromHeader(bytes, data);

  var classValue = (bytes[4] >> 4) & 0x0f;
  var typeValue = bytes[4] & 0x0f;

  if (classValue === 2) {
    // TEMPERATURE notification: signed int8 °C at byte 5.
    if (bytes.length < 6) {
      return { errors: ['temperature notification truncated'] };
    }
    var alarms = ['high', 'low', 'normal'];
    data.notificationType = 'temperature';
    data.temperatureAlarm = alarms[typeValue] || 'unknown';
    data.air = { temperature: toSigned8(bytes[5]) };
    return { data: data };
  }

  if (classValue === 3) {
    // ACCELEROMETER notification: motion start/end or shock -> motion detected.
    var accelTypes = ['motionStart', 'motionEnd', 'shock'];
    data.notificationType = accelTypes[typeValue] || 'accelerometer';
    data.action = { motion: { detected: true } };
    return { data: data };
  }

  return { errors: ['notification class ' + classValue + ' carries no normalized measurement'] };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 4) {
    return { errors: ['payload too short for an Abeeway uplink header'] };
  }

  var b0 = bytes[0] & 0xff;
  var multiFrame = ((b0 >> 7) & 0x01) === 1;
  var messageType = (b0 >> 3) & 0x07;

  if (messageType === 1) {
    return decodeNotification(bytes);
  }
  if (messageType === 2) {
    return decodePosition(bytes, multiFrame);
  }
  if (messageType === 3 || messageType === 4 || messageType === 5) {
    // QUERY / RESPONSE / TELEMETRY frames carry device queries, configuration
    // responses, or stateful timeseries that require prior metadata frames to
    // decode; none yields a self-contained normalized measurement here.
    return { errors: ['message type ' + messageType + ' carries no normalized measurement'] };
  }

  return { errors: ['unsupported Abeeway message type (' + messageType + ')'] };
}
