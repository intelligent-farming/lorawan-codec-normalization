// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for makerfabs/gps-tracker-neo-6m (Makerfabs AgroSense
// LoRaWAN GPS Tracker, NEO-6M GNSS module): an on-device GNSS fix, battery
// voltage, a g-sensor (accelerometer) state byte, and an RTC timestamp carried
// with the fix.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/gps-tracker-neo-6m.js,
// attributed in NOTICE), which emits generic field1..4. The normalization here is
// authored; upstream's output shape is not copied.
//
// SAME FRAME AS THE PA1010D SIBLING. Upstream ships byte-identical decoders for
// makerfabs/gps-tracker-neo-6m and makerfabs/gps-tracker-pa1010d (identical
// sha256, recorded in both device.json files): the two products are the same
// LoRaWAN board carrying a different GNSS module, and they share one 24-byte
// uplink layout. This codec therefore decodes the SAME fields as
// makerfabs/gps-tracker-pa1010d and emits the SAME keys — two devices in one
// category reading one wire format must not disagree on their output, which is
// the whole point of the module. Keep the two codecs in step (see
// `variantOf` in device.json).
//
// Single uplink frame layout (>= 24 bytes):
//   bytes 0-1   message counter (big-endian)        -> messageCounter (extra)
//   byte  2     battery level, decivolts             -> battery (V) = byte/10
//   byte  3     g-sensor state                        -> gSensorState (extra)
//   byte  4     GPS status: 0 = no live fix, else fix -> gates position.*
//   bytes 5-6   year (big-endian)   ]
//   byte  7     month               ]
//   byte  8     day                 ]  RTC timestamp carried with the fix
//   byte  9     hour                ]  -> time (RFC3339, UTC) when present
//   byte  10    minute              ]
//   byte  11    second              ]
//   bytes 12-15 latitude magnitude (big-endian) / 100000  decimal degrees
//   byte  16    N/S hemisphere: 0 = North, else South
//   bytes 17-20 longitude magnitude (big-endian) / 100000 decimal degrees
//   byte  21    E/W hemisphere: 0 = East, else West
//   byte  22    g-sensor on/off                       -> gSensorEnabled (extra)
//   byte  23    g-sensor sensitivity                  -> gSensorSensitivity (extra)
//
// The device decodes the GNSS fix on-board; the magnitude bytes are always
// positive and the hemisphere bytes (16, 21) carry the sign. Upstream derives the
// hemisphere from the (always-positive) magnitude instead of from those bytes, so
// it can never report S/W; this codec applies the hemisphere flags and emits
// signed WGS84 decimal degrees. When gpsStatus is 0 there is no live fix, so
// position.* is suppressed (a zero coordinate would be a false fix). Out-of-range
// coordinates (|lat| > 90, |lon| > 180) are also suppressed, guarding against a
// malformed frame over-reading the fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function be32(bytes, offset) {
  return (
    bytes[offset] * 16777216 +
    bytes[offset + 1] * 65536 +
    bytes[offset + 2] * 256 +
    bytes[offset + 3]
  );
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (bytes.length < 24) {
    return { errors: ['Makerfabs GPS tracker frame requires 24 bytes'] };
  }

  var data = {};

  data.messageCounter = bytes[0] * 256 + bytes[1];
  data.battery = round(bytes[2] / 10, 1);
  data.gSensorState = bytes[3];
  data.gSensorEnabled = bytes[22] === 1;
  data.gSensorSensitivity = bytes[23];

  var gpsStatus = bytes[4];

  if (gpsStatus !== 0) {
    var lat = be32(bytes, 12) / 100000;
    if ((bytes[16] & 0xff) !== 0) {
      lat = -lat;
    }
    lat = round(lat, 5);

    var lon = be32(bytes, 17) / 100000;
    if ((bytes[21] & 0xff) !== 0) {
      lon = -lon;
    }
    lon = round(lon, 5);

    var position = {};
    if (lat >= -90 && lat <= 90) {
      position.latitude = lat;
    }
    if (lon >= -180 && lon <= 180) {
      position.longitude = lon;
    }
    if (position.latitude !== undefined || position.longitude !== undefined) {
      data.position = position;
    }

    var year = bytes[5] * 256 + bytes[6];
    var month = bytes[7];
    var day = bytes[8];
    var hour = bytes[9];
    var minute = bytes[10];
    var second = bytes[11];
    if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      data.time =
        year +
        '-' +
        pad2(month) +
        '-' +
        pad2(day) +
        'T' +
        pad2(hour) +
        ':' +
        pad2(minute) +
        ':' +
        pad2(second) +
        'Z';
    }
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "gps-tracker-neo-6m";
  }
  return result;
}
