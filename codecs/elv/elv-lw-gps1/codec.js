// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the ELV LW-GPS1 (LoRaWAN GPS tracker: GNSS
// position fix, altitude and HDOP, supply voltage, and a transmit-reason byte
// that distinguishes timer / button / heartbeat / motion events).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-gps1-1.0.0.js, attributed
// in NOTICE). The upstream field extraction (header byte + signed little-endian
// int32 lat/lon/altitude) is reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream decoded output).
//
// All application data arrives on fPort 10:
//   bytes[0]            header length (application data begins at bytes[0] + 1)
//   bytes[1] & 0x0F     transmit reason (index into TX_REASON)
//   bytes[2..3]         supply voltage, big-endian millivolts -> battery (V)
//   bytes[index..]      typed application records; type 0x01 is a position fix:
//                         int32 LE latitude  / 1e6  -> position.latitude
//                         int32 LE longitude / 1e6  -> position.longitude
//                         int32 LE altitude  / 1e4  -> altitudeM (extra)
//                         hdop (whole "." frac*4)    -> hdop (extra)
//
// Transmit reason -> txReason (extra). The motion reasons drive
// action.motion.detected: Motion_Start / Motion_Cyclic mean the tracker is
// moving (true), Motion_Stop means it has come to rest (false). Non-motion
// reasons (timer, button, heartbeat, etc.) carry no motion state, so
// action.motion is omitted for them.
//
// Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed frame over-reading the packed fields.

var TX_REASON = [
  'Reserved',
  'Timer_Event',
  'User_Button',
  'GNSS_Timeout',
  'Heartbeat',
  'Input_One_Shot',
  'Input_Cyclic',
  'Motion_Start',
  'Motion_Cyclic',
  'Motion_Stop'
];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function int32le(bytes, i) {
  // `<< 24` already yields a signed 32-bit result in JS.
  return bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
}

function pad2(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }
  if (port !== 10) {
    return { errors: ['unsupported FPort (expected 10)'] };
  }
  if (bytes.length < 4) {
    return { errors: ['header requires at least 4 bytes'] };
  }

  var data = {};
  var reason = TX_REASON[bytes[1] & 0x0f];
  data.txReason = reason;
  data.battery = round(((bytes[2] << 8) | bytes[3]) / 1000, 3);

  if (reason === 'Motion_Start' || reason === 'Motion_Cyclic') {
    data.action = { motion: { detected: true } };
  } else if (reason === 'Motion_Stop') {
    data.action = { motion: { detected: false } };
  }

  var index = bytes[0] + 1;

  // Header-only frame (no application records).
  if (bytes.length <= index) {
    return { data: data };
  }

  while (index < bytes.length) {
    var type = bytes[index];
    if (type === 0x01) {
      if (index + 14 >= bytes.length) {
        return { errors: ['truncated position record'] };
      }
      var lat = int32le(bytes, index + 1) / 1e6;
      var lon = int32le(bytes, index + 5) / 1e6;
      var altitude = round(int32le(bytes, index + 9) / 1e4, 2);
      var hdop = round(parseFloat(String(bytes[index + 13]) + '.' + pad2(bytes[index + 14] * 4)), 2);

      var position = {};
      if (lat >= -90 && lat <= 90) {
        position.latitude = round(lat, 6);
      }
      if (lon >= -180 && lon <= 180) {
        position.longitude = round(lon, 6);
      }
      if (position.latitude !== undefined || position.longitude !== undefined) {
        data.position = position;
      }
      data.altitudeM = altitude;
      data.hdop = hdop;

      index += 15;
    } else {
      return { errors: ['unsupported application data type'] };
    }
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elv";
    result.data.model = "elv-lw-gps1";
  }
  return result;
}
