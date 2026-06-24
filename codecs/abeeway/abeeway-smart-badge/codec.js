// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Abeeway Smart Badge — a multi-mode
// geolocation badge (GPS/GNSS + WiFi/BLE scan + accelerometer + temperature +
// SOS button). It speaks the Abeeway "Asset Tracker 2.0" uplink protocol on
// fPort 18.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Asset Tracker 2.0 frame: byte 0 = message type; byte 1 = tracking
// mode + SOS/app-state/motion/periodic/on-demand flags; byte 2 = battery level;
// byte 3 = condensed temperature; byte 4 = ack token + raw-position type; then a
// per-message body) was ported from and normalized against the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices vendor/abeeway/
// asset-tracker-2.js, attributed in NOTICE). The upstream field extraction is
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream decodeUplink output).
//
// Same Abeeway codec family as codecs/abeeway/abeeway-compact-tracker (verified
// gps-tracker + motion on the identical Asset Tracker 2.0 format); its
// normalization decisions are mirrored here where the formats match.
//
// Decoded -> normalized vocabulary:
//   GPS fix latitude/longitude (signed decimal degrees) -> position.latitude /
//       position.longitude. Only a POSITION_MESSAGE whose raw-position type is
//       GPS carries a genuine on-device fix; WiFi/BLE raw-position types yield
//       scan lists (extras), never a position.
//   condensed temperature (byte 3, -44..85 °C)          -> air.temperature
//   dynamic motion state (MOVING/STATIC)                -> action.motion.detected
//
// Everything else is a device-specific extra (camelCase): messageType,
// trackingMode, rawPositionType, batteryLevel (0..255 fuel-gauge level, NOT a
// volt or a 0..100 percent — kept raw), batteryStatus, horizontalAccuracy (m),
// age (s), sosFlag, appState, periodicPosition, onDemand, eventType, and any
// WiFi/BLE scan list.
//
// Message-type byte (byte 0): 3 = POSITION_MESSAGE, 10 = EVENT are the two
// documented Smart Badge uplinks and are decoded here. Other Asset Tracker 2.0
// message types (heartbeat, energy/health status, activity, shock, etc.) carry
// no normalized measurement and are reported as errors so callers can route
// them rather than receive a bare object.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function byteToHex(b) {
  var hex = (b & 0xff).toString(16);
  if (hex.length < 2) {
    hex = '0' + hex;
  }
  return hex;
}

// Abeeway "condensed" 8-bit codec: maps a byte onto [lo, hi] with nresv reserved
// codes. Ported verbatim from the upstream decodeCondensed.
function decodeCondensed(value, lo, hi, nbits, nresv) {
  return (value - nresv / 2) / (((1 << nbits) - 1 - nresv) / (hi - lo)) + lo;
}

// POSITION_MESSAGE packs lat/lon in 3 bytes = the top 24 bits of a signed
// 1e-7-degree int32 (the upstream appends a "00" low byte before parsing).
function signedDegrees(b0, b1, b2) {
  var coded = b0 * 0x1000000 + b1 * 0x10000 + b2 * 0x100;
  if (coded > 0x7fffffff) {
    coded -= 0x100000000;
  }
  return coded / Math.pow(10, 7);
}

function trackingModeName(payload) {
  var mode = (payload[1] >> 5) & 0x07;
  if (mode === 0) return 'STAND_BY';
  if (mode === 1) return 'MOTION_TRACKING';
  if (mode === 2) return 'PERMANENT_TRACKING';
  if (mode === 3) return 'MOTION_START_END_TRACKING';
  if (mode === 4) return 'ACTIVITY_TRACKING';
  if (mode === 5) return 'OFF';
  return null;
}

function rawPositionTypeName(code) {
  var names = {
    0: 'GPS',
    1: 'GPS_TIMEOUT',
    2: 'ENCRYPTED_WIFI_BSSIDS',
    3: 'WIFI_TIMEOUT',
    4: 'WIFI_FAILURE',
    5: 'XGPS_DATA',
    6: 'XGPS_DATA_WITH_GPS_SW_TIME',
    7: 'BLE_BEACON_SCAN',
    8: 'BLE_BEACON_FAILURE',
    9: 'WIFI_BSSIDS_WITH_NO_CYPHER',
    10: 'BLE_BEACON_SCAN_SHORT_ID',
    11: 'BLE_BEACON_SCAN_LONG_ID'
  };
  return names[code] || 'UNKNOWN';
}

function eventTypeName(code) {
  var names = {
    0: 'GEOLOC_START',
    1: 'MOTION_START',
    2: 'MOTION_END',
    3: 'BLE_CONNECTED',
    4: 'BLE_DISCONNECTED',
    5: 'TEMPERATURE_ALERT',
    6: 'BLE_BOND_DELETED',
    7: 'SOS_MODE_START',
    8: 'SOS_MODE_END',
    9: 'ANGLE_DETECTION',
    10: 'GEOFENCING'
  };
  return names[code];
}

// WiFi/BLE scan: pairs of [6-byte MAC, 1-byte signed RSSI] from body offset 6.
function decodeScans(payload) {
  var list = [];
  var i = 6;
  while (i + 7 <= payload.length) {
    var mac = '';
    for (var j = 0; j < 6; j++) {
      mac += (j > 0 ? ':' : '') + byteToHex(payload[i + j]);
    }
    var rssi = payload[i + 6];
    if (rssi > 0x7f) {
      rssi -= 0x100;
    }
    list.push({ bssid: mac, rssi: rssi });
    i += 7;
  }
  return list;
}

// Shared header fields present on every non-frame-pending Asset Tracker frame.
function decodeHeader(payload) {
  var data = {};

  data.messageType =
    payload[0] === 3 ? 'POSITION_MESSAGE' : payload[0] === 10 ? 'EVENT' : 'UNKNOWN';

  var mode = trackingModeName(payload);
  if (mode !== null) {
    data.trackingMode = mode;
  }

  data.sosFlag = (payload[1] >> 4) & 0x01;
  data.appState = (payload[1] >> 3) & 0x01;
  data.periodicPosition = ((payload[1] >> 1) & 0x01) === 1;
  data.onDemand = (payload[1] & 0x01) === 1;

  // Dynamic motion state -> action.motion.detected (MOVING = true).
  var moving = (payload[1] >> 2) & 0x01;
  data.action = { motion: { detected: moving === 1 } };

  // Battery level: 0..255 fuel-gauge level (0/255 = no reading). NOT volts and
  // NOT a 0..100 percent, so it stays a raw extra rather than `battery` /
  // `batteryPercent`.
  var bl = payload[2];
  if (bl !== 0 && bl !== 255) {
    data.batteryLevel = bl;
  }
  data.batteryStatus = bl === 0 ? 'CHARGING' : bl === 255 ? 'UNKNOWN' : 'OPERATING';

  // Condensed temperature (byte 3) -> air.temperature.
  data.air = { temperature: round(decodeCondensed(payload[3], -44, 85, 8, 0), 1) };

  // Ack token (high nibble of byte 4).
  data.ackToken = (payload[4] >> 4) & 0x0f;

  return data;
}

function decodePositionMessage(payload, data) {
  var rawType = payload[4] & 0x0f;
  data.rawPositionType = rawPositionTypeName(rawType);

  if (rawType === 0) {
    // GPS fix — genuine on-device latitude/longitude.
    if (payload.length < 13) {
      return { errors: ['payload too short for a GPS position fix'] };
    }
    data.age = Math.round(decodeCondensed(payload[5], 0, 2040, 8, 0));
    var lat = signedDegrees(payload[6], payload[7], payload[8]);
    var lon = signedDegrees(payload[9], payload[10], payload[11]);
    var position = {};
    if (lat >= -90 && lat <= 90) {
      position.latitude = round(lat, 7);
    }
    if (lon >= -180 && lon <= 180) {
      position.longitude = round(lon, 7);
    }
    if (position.latitude === undefined || position.longitude === undefined) {
      return { errors: ['GPS fix produced an out-of-range latitude or longitude'] };
    }
    data.position = position;
    data.horizontalAccuracy = round(decodeCondensed(payload[12], 0, 1000, 8, 0), 2);
    return { data: data };
  }

  // Non-GPS raw-position types do not carry an on-device fix. WiFi/BLE scan
  // types expose their scan list as an extra; the rest are status-only.
  if (rawType === 9 || rawType === 7) {
    // WIFI_BSSIDS_WITH_NO_CYPHER / BLE_BEACON_SCAN: MAC+RSSI list.
    data.age = Math.round(decodeCondensed(payload[5], 0, 2040, 8, 0));
    if (payload.length >= 13) {
      var scans = decodeScans(payload);
      if (scans.length) {
        data.scans = scans;
      }
    }
  }
  return { data: data };
}

function decodeEvent(payload, data) {
  if (payload.length < 6) {
    return { errors: ['payload too short for an EVENT frame'] };
  }
  var ev = eventTypeName(payload[5]);
  if (ev === undefined) {
    return { errors: ['unknown event type'] };
  }
  data.eventType = ev;
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['payload too short for an Abeeway Asset Tracker frame'] };
  }

  var messageType = bytes[0];
  // Only POSITION_MESSAGE (3) and EVENT (10) carry a normalized measurement.
  if (messageType !== 3 && messageType !== 10) {
    return {
      errors: ['unsupported message type (only POSITION_MESSAGE and EVENT carry a normalized measurement)']
    };
  }

  if (bytes.length < 5) {
    return { errors: ['payload too short for an Abeeway Asset Tracker header'] };
  }

  var data = decodeHeader(bytes);

  if (messageType === 3) {
    return decodePositionMessage(bytes, data);
  }
  return decodeEvent(bytes, data);
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "abeeway";
    result.data.model = "abeeway-smart-badge";
  }
  return result;
}
