// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the ELV LW-GPS2 (LoRaWAN GPS tracker: on-device
// GNSS position fix with altitude and HDOP, supply voltage, motion / event
// transmit reason, and application / bootloader firmware versions).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-gps2.js, attributed in
// NOTICE). The upstream field extraction (a TLV stream on fPort 10) is
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream `decoded` object).
//
// All application data arrives on fPort 10 as a sequence of type-led blocks:
//   0x01 app version   3 bytes  major.minor.patch        -> appVersion (extra)
//   0x02 bootloader    3 bytes  major.minor.patch        -> blVersion (extra)
//   0x03 tx reason     1 byte   event-code index         -> txReason (extra)
//   0x04 supply voltage 2 bytes big-endian millivolts    -> battery (V)
//   0x0A positioning   14 bytes int32 LE lat/lon * 1e-6, -> position.latitude /
//                               int32 LE altitude * 1e-4,    position.longitude,
//                               2 bytes HDOP (b + b*4/100)   altitudeMeters, hdop
//
// The transmit-reason byte indexes a fixed event table. The MOTION_START and
// MOTION_CYCLIC events mean the tracker is in motion; MOTION_STOP means it has
// come to rest. For any of these three motion events we publish
// action.motion.detected (true while moving, false on stop).
//
// Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed frame over-reading the packed position fields.

var TX_REASON = [
  'UNDEFINED_EVENT',      // 0x00
  'TIMER_EVENT',          // 0x01
  'USER_BUTTON_EVENT',    // 0x02
  'GNSS_TIMEOUT_EVENT',   // 0x03
  'HEARTBEAT_EVENT',      // 0x04
  'INPUT_ONE_SHOT_EVENT', // 0x05
  'INPUT_CYCLIC_EVENT',   // 0x06
  'MOTION_START_EVENT',   // 0x07
  'MOTION_CYCLIC_EVENT',  // 0x08
  'MOTION_STOP_EVENT'     // 0x09
];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function int32LE(bytes, i) {
  var v = bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536 + bytes[i + 3] * 16777216;
  if (v >= 0x80000000) {
    v -= 0x100000000;
  }
  return v;
}

function pad2(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (port !== 10) {
    return { errors: ['unsupported FPort (expected 10)'] };
  }
  if (bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var warnings = [];
  var index = 0;

  while (index < bytes.length) {
    var type = bytes[index];

    if (type === 0x01) {
      data.appVersion = 'V' + bytes[index + 1] + '.' + bytes[index + 2] + '.' + bytes[index + 3];
      index += 4;
    } else if (type === 0x02) {
      data.blVersion = 'V' + bytes[index + 1] + '.' + bytes[index + 2] + '.' + bytes[index + 3];
      index += 4;
    } else if (type === 0x03) {
      var code = bytes[index + 1];
      if (code >= TX_REASON.length) {
        data.txReason = 'UNKNOWN_EVENT';
      } else {
        data.txReason = TX_REASON[code];
        if (code === 0x07 || code === 0x08) {
          data.action = { motion: { detected: true } };
        } else if (code === 0x09) {
          data.action = { motion: { detected: false } };
        }
      }
      index += 2;
    } else if (type === 0x04) {
      var mv = (bytes[index + 1] << 8) | bytes[index + 2];
      data.battery = round(mv / 1000, 3);
      index += 3;
    } else if (type === 0x0a) {
      var lat = int32LE(bytes, index + 1) / 1e6;
      var lon = int32LE(bytes, index + 5) / 1e6;
      var alt = round(int32LE(bytes, index + 9) / 10000, 2);
      var hdopWhole = bytes[index + 13];
      var hdopFrac = bytes[index + 14] * 4;
      var hdop = round(parseFloat(String(hdopWhole) + '.' + pad2(hdopFrac)), 2);

      var position = {};
      if (lat >= -90 && lat <= 90) {
        position.latitude = round(lat, 6);
      }
      if (lon >= -180 && lon <= 180) {
        position.longitude = round(lon, 6);
      }
      if (position.latitude !== undefined || position.longitude !== undefined) {
        data.position = position;
      } else {
        warnings.push('position out of range');
      }
      data.altitudeMeters = alt;
      data.hdop = hdop;
      index += 15;
    } else {
      return { errors: ['unknown data type 0x' + (type & 0xff).toString(16)] };
    }
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
    result.data.make = "elv";
    result.data.model = "elv-lw-gps2";
  }
  return result;
}
