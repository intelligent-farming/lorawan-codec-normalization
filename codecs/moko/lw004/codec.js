// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MOKO LW004-PB (LoRaWAN panic button / asset
// tracker: GPS + BLE-beacon positioning, accelerometer, alarm button,
// battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood from the MOKO LW004-PB User Manual V1.2, section 7 "Uplink
// Payload" (including the worked example on page 11). The upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/moko/lw004.js, attributed in
// NOTICE) was also consulted; its normalizeUplink is NOT copied. Note the
// manual documents a single flat uplink layout (this firmware variant), which
// differs from the multi-fPort message format in the upstream snapshot — the
// authoritative manual layout is implemented here.
//
// Uplink layout (manual V1.2 section 7, byte index 0-based):
//   [0]     Battery level (0x00-0x64), a PERCENTAGE.
//   [1]     Alarm status (0x00 off / 0x01 on).
//   [2..5]  GPS latitude, LITTLE-endian signed int32; degrees = raw*90/8388607.
//   [6..9]  GPS longitude, LITTLE-endian signed int32; degrees = raw*180/8388607.
//   [10..]  variable tail: up to four BLE beacon MAC(6)+RSSI(1) records, then
//           X/Y/Z acceleration (big-endian, g = raw*2/32768) and angular. The
//           manual's fixed byte indices (beacons 11-38, accel 39-44) are the
//           MAXIMUM-length case; real frames pack only the fields actually
//           present (the manual's own worked example is a 25-byte short frame
//           carrying one beacon then accel). Because the accelerometer/beacon
//           offsets are not deterministically recoverable from frame length
//           alone, this codec decodes only the fixed-offset leading fields
//           (battery, alarm, GPS) — which are the vocabulary-relevant ones —
//           and does not emit the ambiguous variable tail.
//
// Mapping notes:
//   - GPS latitude/longitude -> position.latitude / position.longitude
//     (decimal degrees, WGS84). This is the only vocabulary-mappable
//     measurement; it satisfies the gps-tracker category.
//   - Battery level is a PERCENTAGE on this device, not a voltage, so it is the
//     camelCase extra `batteryPercent`. The vocabulary `battery` (volts) is not
//     emitted because the payload carries no voltage.
//   - Alarm status -> camelCase extra `alarm` (boolean). The accelerometer is a
//     raw motion diagnostic (g per axis), NOT the boolean/count action.motion
//     model, so it would never be forced into action.motion even if decoded.
//   - There is no light/lux sensor in the uplink, so air.lightIntensity is
//     never emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// little-endian signed 32-bit
function s32le(bytes, start) {
  var v =
    (bytes[start] |
      (bytes[start + 1] << 8) |
      (bytes[start + 2] << 16) |
      (bytes[start + 3] << 24)) >>>
    0;
  if (v > 0x80000000) {
    v = v - 0x100000000;
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  // Minimum layout: battery + alarm + 4-byte lat + 4-byte lon = 10 bytes.
  if (bytes.length < 10) {
    return { errors: ['uplink payload too short for a GPS fix'] };
  }

  var batteryPercent = bytes[0];
  var alarmOn = bytes[1] === 1;

  var lat = (s32le(bytes, 2) * 90) / 8388607;
  var lon = (s32le(bytes, 6) * 180) / 8388607;

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { errors: ['gps coordinates out of range'] };
  }
  if (batteryPercent < 0 || batteryPercent > 100) {
    return { errors: ['battery percentage out of range'] };
  }

  var data = {
    position: {
      latitude: round(lat, 7),
      longitude: round(lon, 7)
    },
    batteryPercent: batteryPercent,
    alarm: alarmOn
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "moko";
    result.data.model = "lw004";
  }
  return result;
}
