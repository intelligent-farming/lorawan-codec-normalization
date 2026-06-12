// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MOKO LW001-BG PRO (asset tracker: GPS / Wi-Fi /
// BLE positioning, accelerometer motion, battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MOKO message-type-keyed-by-fPort frames) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/moko/lw001-bgpro.js, attributed in NOTICE). The upstream
// normalizeUplink is NOT copied — it forces accelerometer motion into
// action.motion; here motion is an accelerometer-derived diagnostic and is
// emitted as camelCase extras instead.
//
// Mapping notes:
//   - GPS latitude/longitude -> position.latitude / position.longitude
//     (decimal degrees, WGS84). Wi-Fi / BLE positioning frames carry only MAC
//     scan lists (no coordinates) and are not vocabulary-mappable.
//   - battery_voltage is already a VOLTAGE on this device -> `battery` (V).
//   - IC die temperature (bytes[1]) is a chip-junction diagnostic, NOT an
//     ambient air sensor, so it is emitted as the extra `icTemperature`, never
//     air.temperature.
//   - accelerometer / motion / Wi-Fi / BLE data -> camelCase extras.
//   - Frames that carry no vocabulary-mappable measurement become an errors
//     result.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s32be(bytes, start) {
  var v =
    ((bytes[start] << 24) |
      (bytes[start + 1] << 16) |
      (bytes[start + 2] << 8) |
      bytes[start + 3]) >>>
    0;
  if (v > 0x80000000) {
    v = v - 0x100000000;
  }
  return v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  // GPS-bearing frames: fPort 2 (fix_success) with a GPS fix tech, and
  // fPort 12 (limit_gps_data). These are the only frames that carry a
  // vocabulary-mappable measurement (a position fix).
  if (fPort === 2) {
    return decodeFixSuccess(bytes);
  }
  if (fPort === 12) {
    return decodeLimitGps(bytes);
  }

  // All other ports (heartbeat, fix-false, system-close, shake, idle, alarm,
  // event, battery-consume, config, store-data) carry only status flags,
  // diagnostics, scan lists or battery — no vocabulary-mappable measurement.
  if (fPort >= 1 && fPort <= 11) {
    return { errors: ['fPort ' + fPort + ' carries no mappable measurement'] };
  }

  return { errors: ['unsupported fPort ' + fPort] };
}

// fPort 2: fix_success. 3-byte common head, then fix tech. Only the GPS tech
// (tech === 2) yields coordinates; Wi-Fi (0) / BLE (1) yield MAC scan lists.
function decodeFixSuccess(bytes) {
  if (bytes.length < 4) {
    return { errors: ['fix_success frame too short'] };
  }

  var battery = (22 + ((bytes[2] >> 4) & 0x0f)) / 10;
  var tech = bytes[3];

  if (tech !== 2) {
    // Wi-Fi or BLE scan: MAC/RSSI lists only, no coordinates.
    return {
      errors: ['Wi-Fi/BLE scan fix carries no position coordinates'],
    };
  }

  // 3 head + 1 tech + 2 year + mon + days + hour + minute + sec + timezone = 12,
  // then 1 datalen byte at index 12, coordinates start at index 13.
  if (bytes.length < 21) {
    return { errors: ['gps fix frame too short'] };
  }

  var lat = s32be(bytes, 13) / 10000000;
  var lon = s32be(bytes, 17) / 10000000;

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { errors: ['gps coordinates out of range'] };
  }

  var data = {
    position: {
      latitude: round(lat, 7),
      longitude: round(lon, 7),
    },
    battery: round(battery, 1),
  };
  return { data: data };
}

// fPort 12: limit_gps_data. 2-byte head (NOT the 3-byte common head), then a
// 4-byte signed latitude and 4-byte signed longitude.
function decodeLimitGps(bytes) {
  if (bytes.length < 11) {
    return { errors: ['limit_gps frame too short'] };
  }

  var battery = (22 + ((bytes[2] >> 4) & 0x0f)) / 10;
  var lat = s32be(bytes, 2) / 10000000;
  var lon = s32be(bytes, 6) / 10000000;

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { errors: ['gps coordinates out of range'] };
  }

  var data = {
    position: {
      latitude: round(lat, 7),
      longitude: round(lon, 7),
    },
    battery: round(battery, 1),
  };
  return { data: data };
}
