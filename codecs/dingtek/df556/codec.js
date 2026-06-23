// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dingtek DF556 (LoRaWAN level sensor that can
// also report an on-device GNSS position fix; sibling of the DF555). The unit
// emits a tank/fill level and, when GPS is enabled, a live latitude/longitude
// solution from its onboard receiver, plus battery voltage, alarm flags and a
// frame counter; a separate configuration packet reports firmware and settings.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/df556.js, attributed in
// NOTICE). The upstream field extraction (fixed big-endian level/volt counters
// and the little-endian IEEE-754 lat/lon words) is reproduced faithfully; only
// the JSON shape is re-authored to the normalized vocabulary. Upstream emits
// lat/lon as toFixed(6) strings — we publish them as numbers under position.*.
//
// All payloads arrive on FPort 3. Frame type is keyed off length:
//   18 bytes  heartbeat, no GPS   — level + battery + flags (no position fix)
//   26 bytes  heartbeat with GPS  — adds IEEE-754 LE longitude/latitude
//   17 bytes  configuration packet — firmware + intervals + thresholds
// In the heartbeat frames byte[3] must NOT equal 0x03; in the config frame it
// must equal 0x03 (matching the upstream length+marker discriminator).
//
// Battery: upstream exposes a raw `volt` count (e.g. 360). The DF55x family packs
// the cell voltage in hundredths of a volt, so 360 -> 3.60 V (a plausible Li cell;
// the ÷1000 mV reading of 0.36 V is non-physical). We publish volts under the
// vocabulary key `battery` (÷100), rounded to 0.01 V.
//
// position.latitude/longitude are signed decimal degrees (WGS84), rounded to the
// device's 6-decimal resolution. Out-of-range coordinates (|lat| > 90,
// |lon| > 180) are suppressed, guarding against a malformed frame; if neither
// coordinate survives no position object is published.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// IEEE-754 single-precision reconstruction from a 32-bit word. The console
// sandbox has no binary typed-array helpers, so decode sign/exponent/mantissa
// by hand (ported faithfully from the upstream decoder).
function hex2float(num) {
  var sign = num & 0x80000000 ? -1 : 1;
  var exponent = ((num >> 23) & 0xff) - 127;
  var mantissa = 1 + (num & 0x7fffff) / 0x7fffff;
  return sign * mantissa * Math.pow(2, exponent);
}

function u16be(bytes, i) {
  return (bytes[i] << 8) + bytes[i + 1];
}

function decodeHeartbeat(bytes, hasGps) {
  var data = {};

  data.level = u16be(bytes, 5);
  data.gpsEnabled = Boolean(bytes[7]);

  if (hasGps) {
    data.alarmLevel = Boolean(bytes[19] >> 4);
    data.alarmBattery = Boolean(bytes[20] & 0x0f);
    data.battery = round(u16be(bytes, 21) / 100, 2);
    data.frameCounter = u16be(bytes, 23);

    var lonWord = (bytes[11] << 24) + (bytes[10] << 16) + (bytes[9] << 8) + bytes[8];
    var latWord = (bytes[15] << 24) + (bytes[14] << 16) + (bytes[13] << 8) + bytes[12];
    var lon = round(hex2float(lonWord), 6);
    var lat = round(hex2float(latWord), 6);

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
  } else {
    data.alarmLevel = Boolean(bytes[11] >> 4);
    data.alarmBattery = Boolean(bytes[12] & 0x0f);
    data.battery = round(u16be(bytes, 13) / 100, 2);
    data.frameCounter = u16be(bytes, 15);
  }

  return { data: data };
}

function decodeConfig(bytes) {
  return {
    data: {
      firmware: bytes[5] + '.' + bytes[6],
      uploadInterval: u16be(bytes, 7),
      detectInterval: bytes[9],
      levelThreshold: bytes[10],
      density: u16be(bytes, 12),
      batteryThreshold: bytes[14],
      workMode: bytes[15]
    }
  };
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort (expected 3)'] };
  }
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (bytes.length === 18) {
    if (bytes[3] === 0x03) {
      return { errors: ['wrong length'] };
    }
    return decodeHeartbeat(bytes, false);
  }
  if (bytes.length === 26) {
    return decodeHeartbeat(bytes, true);
  }
  if (bytes.length === 17) {
    if (bytes[3] !== 0x03) {
      return { errors: ['wrong length'] };
    }
    return decodeConfig(bytes);
  }

  return { errors: ['wrong length'] };
}
