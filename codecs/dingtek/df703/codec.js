// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF703 (LoRaWAN ultrasonic waste-bin
// fill-level sensor with optional on-board GNSS, fire/tilt/level/battery alarms,
// a tilt angle and an on-die temperature reading).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df703.js, attributed in
// NOTICE). The upstream field extraction (fixed big-endian byte offsets and the
// IEEE-754 hex->float coordinate decode) is reproduced faithfully; only the JSON
// shape is re-authored to the normalized vocabulary (never the upstream output
// object). The DF703 is the GNSS-bearing sibling of the DF702.
//
// Frames arrive only on FPort 3:
//   17 bytes              heartbeat, no GPS fix
//   25 bytes, bytes[3]==3 parameter / configuration packet (no fix)
//   25 bytes, otherwise   heartbeat WITH GPS fix
//
// GPS frames carry a live GNSS solution: longitude then latitude, each a
// little-endian-assembled 32-bit IEEE-754 single decoded to signed decimal
// degrees (WGS84) -> position.latitude / position.longitude. Coordinates outside
// [-90,90] / [-180,180] are suppressed (guards a malformed/over-read frame).
//
// Normalized keys: position.* (GNSS fix), air.temperature (on-die degC).
// Device-specific extras (camelCase): fillLevel (cm), tiltAngle (deg),
// alarmLevel / alarmFire / alarmFall / alarmBattery (booleans), frameCounter,
// and the configuration fields on the parameter packet. There is no battery
// voltage in the payload (only a battery alarm flag), so no `battery` key.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// IEEE-754 single-precision: interpret a 32-bit unsigned integer as a float.
// Reproduced from the upstream decoder.
function hex2float(num) {
  var sign = num & 0x80000000 ? -1 : 1;
  var exponent = ((num >> 23) & 0xff) - 127;
  var mantissa = 1 + (num & 0x7fffff) / 0x7fffff;
  return sign * mantissa * Math.pow(2, exponent);
}

function decodeHeartbeat(bytes, base) {
  // base is the index of the temperature byte; fill level is always bytes[5..6].
  // Upstream reads the tilt-angle sign nibble at base+1 and the magnitude at
  // base+2, but its sign expression `bytes[base+1] & (0x0f === 0x00) ? ...`
  // reduces to `bytes[base+1] & false` (= 0, falsy), so the angle is always
  // `-bytes[base+2]`. Reproduced faithfully.
  var data = {
    fillLevel: (bytes[5] << 8) + bytes[6],
    tiltAngle: 0 - bytes[base + 2],
    alarmLevel: Boolean(bytes[base + 3] >> 4),
    alarmFire: Boolean(bytes[base + 3] & 0x0f),
    alarmFall: Boolean(bytes[base + 4] >> 4),
    alarmBattery: Boolean(bytes[base + 4] & 0x0f),
    frameCounter: (bytes[base + 5] << 8) + bytes[base + 6]
  };

  data.air = { temperature: bytes[base] };

  return data;
}

function decodeParameters(bytes) {
  return {
    data: {
      firmware: bytes[5] + '.' + bytes[6],
      uploadInterval: bytes[7],
      detectInterval: bytes[8],
      levelThreshold: bytes[9],
      fireThreshold: bytes[10],
      fallThreshold: bytes[11],
      fallEnable: Boolean(bytes[12]),
      workMode: bytes[14]
    }
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }

  if (bytes.length === 17) {
    // Heartbeat without GPS: temperature at byte 8.
    return { data: decodeHeartbeat(bytes, 8) };
  }

  if (bytes.length === 25) {
    if (bytes[3] === 0x03) {
      return decodeParameters(bytes);
    }
    // Heartbeat with GPS: temperature at byte 16.
    var data = decodeHeartbeat(bytes, 16);

    var lon = hex2float((bytes[11] << 24) + (bytes[10] << 16) + (bytes[9] << 8) + bytes[8]);
    var lat = hex2float((bytes[15] << 24) + (bytes[14] << 16) + (bytes[13] << 8) + bytes[12]);
    lon = round(lon, 6);
    lat = round(lat, 6);

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

    return { data: data };
  }

  return { errors: ['wrong length (expected 17 or 25 bytes)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "df703";
  }
  return result;
}
