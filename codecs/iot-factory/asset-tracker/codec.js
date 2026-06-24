// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the IoT Factory Asset Tracker (LoRaWAN GPS asset
// tracker, sibling of iot-factory/personal-tracker): on-device GNSS position
// fix, ground speed, altitude and satellite count, in-trip motion state, an
// optional temperature frame, and battery charge percentage.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/iot-factory/generic-decoder.js,
// attributed in NOTICE). The upstream field extraction (the framed,
// little-endian "generic" protocol carried on FPort 10) is reproduced
// faithfully; only the JSON shape is re-authored to the normalized vocabulary
// (never the upstream Decode() output, which emits an array of typed frames).
//
// Wire layout (FPort 10):
//   byte 0  power info     bit0 = power source (0 battery / 1 external),
//                          bits 1-7 = battery charge percentage.
//   byte 1  protocol info  bit0 = serial-number present, bits 1-3 = protocol
//                          version, bit4 = payload-size present.
//   [4]     serial number  uint32 LE, present only when bit0 of byte 1 set.
//   [2]     payload size   uint16 LE, present only when bit4 of byte 1 set.
//   then a sequence of frames, each:
//     uint16 LE header: low 12 bits = frame type, high 4 bits = reason.
//     a type-specific body.
//
// This tracker is a GPS asset tracker, so we decode the on-device fix frames
// and normalize them; the device's generic protocol can also carry many other
// frame types (Wi-Fi/LBS cloud-geolocation scans, Modbus, pulse counters, etc.)
// which are NOT an on-device position and are not modeled here.
//   GNSS frame (type 0x03): on-device GNSS solution.
//     latitude/longitude  signed decimal degrees (WGS84), int32 LE / 1e5.
//       -> position.latitude / position.longitude.
//     in_movement bit     -> action.motion.detected.
//     altitude / ground speed (km/h -> m/s) / HDOP / satellites -> extras.
//   Temperature frame (type 0x0f): int16 LE tenths of degC -> air.temperature.
//   Movement frame (type 0x13): boolean motion -> action.motion.detected.
//   Battery charge percentage -> batteryPercent (a percentage, NOT volts, so
//     it must not go into the vocabulary `battery` key).
//
// We surface the FIRST GNSS fix in the uplink as the live position. A fix with
// no satellites (used_sat === 0) is treated as no valid solution and position.*
// is suppressed. Out-of-range coordinates (|lat| > 90, |lon| > 180) are also
// suppressed, guarding against a malformed frame over-reading the packed fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function readUInt16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readUInt32LE(bytes, offset) {
  return ((bytes[offset]) |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16)) +
    (bytes[offset + 3] * 0x1000000);
}

function readInt16LE(bytes, offset) {
  var val = bytes[offset] | (bytes[offset + 1] << 8);
  if (val & 0x8000) {
    val -= 0x10000;
  }
  return val;
}

function readInt32LE(bytes, offset) {
  var val = readUInt32LE(bytes, offset);
  if (val >= 0x80000000) {
    val -= 0x100000000;
  }
  return val;
}

function isoTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['missing payload bytes'] };
  }
  if (input.fPort !== 10) {
    return { errors: ['unsupported FPort (expected 10)'] };
  }
  if (bytes.length < 2) {
    return { errors: ['payload too short for header'] };
  }

  var data = {};
  var warnings = [];

  // Header.
  var batteryPct = (bytes[0] & 0xfe) >> 1;
  data.batteryPercent = batteryPct;
  data.externalPower = (bytes[0] & 0x01) !== 0;

  var hasSerial = (bytes[1] & 0x01) !== 0;
  var hasPayloadSize = (bytes[1] & 0x10) !== 0;

  var offset = 2;
  if (hasSerial) {
    if (offset + 4 > bytes.length) {
      return { errors: ['truncated serial number'] };
    }
    offset += 4;
  }
  if (hasPayloadSize) {
    if (offset + 2 > bytes.length) {
      return { errors: ['truncated payload size'] };
    }
    offset += 2;
  }

  var gotPosition = false;
  var sawFrame = false;
  var motionDetected = null;

  // Walk the frame list.
  while (offset + 2 <= bytes.length) {
    var header = readUInt16LE(bytes, offset);
    var type = header & 0x0fff;
    offset += 2;

    if (type === 0x03) {
      // GNSS fix.
      if (offset + 18 > bytes.length) {
        return { errors: ['truncated GNSS frame'] };
      }
      sawFrame = true;
      var ts = readUInt32LE(bytes, offset);
      var lat = round(readInt32LE(bytes, offset + 4) / 100000, 5);
      var lon = round(readInt32LE(bytes, offset + 8) / 100000, 5);
      var alt = readUInt16LE(bytes, offset + 12);
      var speedKmh = readUInt16LE(bytes, offset + 14);
      var hdop = round(bytes[offset + 16] / 10, 1);
      var gnssByte = bytes[offset + 17];
      var sats = gnssByte & 0x1f;
      var moving = (gnssByte & 0x80) !== 0;
      offset += 18;

      if (moving) {
        motionDetected = true;
      } else if (motionDetected === null) {
        motionDetected = false;
      }

      var latOk = lat >= -90 && lat <= 90;
      var lonOk = lon >= -180 && lon <= 180;
      if (!gotPosition && sats > 0 && latOk && lonOk) {
        data.position = { latitude: lat, longitude: lon };
        data.time = isoTime(ts);
        data.altitude = alt;
        data.speedKmph = speedKmh;
        data.speed = round(speedKmh / 3.6, 3);
        data.hdop = hdop;
        data.satellites = sats;
        gotPosition = true;
      } else if (sats === 0) {
        warnings.push('GNSS frame has no satellite fix');
      }
    } else if (type === 0x0f) {
      // Temperature frame: unixtime(4), sensor(1), int16 LE tenths of degC.
      if (offset + 7 > bytes.length) {
        return { errors: ['truncated temperature frame'] };
      }
      sawFrame = true;
      var temp = round(readInt16LE(bytes, offset + 5) / 10, 1);
      if (!data.air) {
        data.air = {};
      }
      data.air.temperature = temp;
      offset += 7;
    } else if (type === 0x13) {
      // Movement frame: unixtime(4), is_movement(1).
      if (offset + 5 > bytes.length) {
        return { errors: ['truncated movement frame'] };
      }
      sawFrame = true;
      if (bytes[offset + 4] === 1) {
        motionDetected = true;
      } else if (bytes[offset + 4] === 0 && motionDetected === null) {
        motionDetected = false;
      }
      offset += 5;
    } else {
      return { errors: ['unknown frame type ' + type] };
    }
  }

  if (!sawFrame) {
    return { errors: ['no decodable frames'] };
  }

  if (motionDetected !== null) {
    data.action = { motion: { detected: motionDetected } };
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
    result.data.make = "iot-factory";
    result.data.model = "asset-tracker";
  }
  return result;
}
