// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the dnt LW-ATS LoRaWAN Asset Tracker Solar
// (GNSS asset tracker: on-device decimal-degree position fix, fix quality /
// time-to-fix diagnostics, trip/motion state, battery voltage, plus start-up,
// heartbeat, GNSS-timeout, configuration and quality-of-service frames).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dnt/dnt-lw-ats.js, attributed in
// NOTICE). The upstream field extraction (byte[0] battery, then a stream of
// type/reason-tagged records) is reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream decoded output).
//
// Frame layout: byte[0] is always the packed battery voltage. The remaining
// bytes form one record, tagged by a leading byte whose low nibble is the
// message type and (for a position fix) whose high nibble is the reason for
// transmission:
//   type 0  POWER_ON      — hardware revision, firmware / bootloader versions
//   type 1  HEARTBEAT     — GNSS activation / timeout / false-activation counts
//   type 2  GNSS_DATA_DD  — decimal-degree position fix (lat/lon * 1e-6),
//                           altitude (int16, m), HDOP, time-to-fix
//   type 3  GNSS_TIMEOUT  — satellites in view, GNSS active time (no fix)
//   type 5  QOS_INFO      — quality-of-service state
// (Types 4 CONFIG and 6 EXTENDED_GNSS_DATA carry no normalized measurement.)
//
// Mapping to the vocabulary:
//   voltage      -> battery (V)
//   lat/lon      -> position.latitude / position.longitude (decimal degrees)
//   reason Start/Further trip -> action.motion.detected = true
//   reason End trip           -> action.motion.detected = false
//   altitude / hdop / ttf / satellites / counts / versions / reason / qosState
//                -> camelCase extras
//
// Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed frame over-reading the packed fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// byte[0] packs an integer-volt part (bits 6-7, +1 offset) and a 20 mV
// fractional part (bits 0-5).
function decodeVoltage(value) {
  var volt = 1 + (value >> 6);
  var millivolt = (value & 0x3f) * 20 / 1000;
  return round(volt + millivolt, 2);
}

// HDOP is packed as integer byte + (fraction byte * 4 / 100).
function decodeDop(b0, b1) {
  return round(b0 + b1 * 4 / 100, 2);
}

function uint32le(bytes, i) {
  return (
    (bytes[i] & 0xff) +
    (bytes[i + 1] & 0xff) * 256 +
    (bytes[i + 2] & 0xff) * 65536 +
    (bytes[i + 3] & 0xff) * 16777216
  );
}

// Reason-for-transmission codes (high nibble of the position record tag).
function reasonAsStr(reason) {
  if (reason === 1) { return 'Button'; }
  if (reason === 2) { return 'Cycle'; }
  if (reason === 3) { return 'Start trip'; }
  if (reason === 4) { return 'Trip'; }
  if (reason === 5) { return 'End trip'; }
  if (reason === 6) { return 'Requested by User'; }
  if (reason === 7) { return 'POR'; }
  return 'unknown';
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }

  var data = {};
  var warnings = [];
  var index = 0;

  data.battery = decodeVoltage(bytes[index] & 0xff);
  index += 1;

  if (index >= bytes.length) {
    return { errors: ['payload carries no record after the battery byte'] };
  }

  // Records are chained after the battery byte; each is tagged by a leading
  // byte whose low nibble is the message type (and, for a fix, whose high
  // nibble is the reason). A position fix may be followed by a QoS record.
  var recordsSeen = 0;

  while (index < bytes.length) {
    var tag = bytes[index] & 0xff;
    index += 1;
    var type = tag & 0x0f;

    if (type === 0) {
      // POWER_ON: 1 byte hw revision + 3 bytes fw version + 3 bytes bl version.
      if (bytes.length < index + 7) {
        return { errors: ['power-on record requires 7 bytes'] };
      }
      data.reason = 'Start-up';
      data.hardwareRevision = String.fromCharCode(bytes[index] & 0xff);
      data.firmwareVersion =
        (bytes[index + 1] & 0xff) + '.' + (bytes[index + 2] & 0xff) + '.' + (bytes[index + 3] & 0xff);
      data.bootloaderVersion =
        (bytes[index + 4] & 0xff) + '.' + (bytes[index + 5] & 0xff) + '.' + (bytes[index + 6] & 0xff);
      index += 7;
    } else if (type === 1) {
      // HEARTBEAT: three 24-bit counters + 1-byte average time-to-fix (2 s units).
      if (bytes.length < index + 10) {
        return { errors: ['heartbeat record requires 10 bytes'] };
      }
      data.reason = 'Heartbeat';
      data.gpsActivations =
        (bytes[index] & 0xff) * 65536 + (bytes[index + 1] & 0xff) * 256 + (bytes[index + 2] & 0xff);
      data.gpsTimeouts =
        (bytes[index + 3] & 0xff) * 65536 + (bytes[index + 4] & 0xff) * 256 + (bytes[index + 5] & 0xff);
      data.falseActivations =
        (bytes[index + 6] & 0xff) * 65536 + (bytes[index + 7] & 0xff) * 256 + (bytes[index + 8] & 0xff);
      data.averageTimeToFixS = (bytes[index + 9] & 0xff) * 2;
      index += 10;
    } else if (type === 2) {
      // GNSS_DATA_DECIMAL_DEGREE: a live on-device position fix.
      if (bytes.length < index + 13) {
        return { errors: ['position record requires 13 bytes'] };
      }
      var reason = tag >> 4;
      data.reason = reasonAsStr(reason);

      var lat = round(uint32le(bytes, index) / 1000000, 6);
      var lon = round(uint32le(bytes, index + 4) / 1000000, 6);

      var altitude = (bytes[index + 8] & 0xff) * 256 + (bytes[index + 9] & 0xff);
      if ((altitude & 0x8000) > 0) {
        altitude = altitude - 0x10000;
      }
      var hdop = decodeDop(bytes[index + 10] & 0xff, bytes[index + 11] & 0xff);
      var ttf = (bytes[index + 12] & 0xff) * 2;

      var position = {};
      if (lat >= -90 && lat <= 90) {
        position.latitude = lat;
      }
      if (lon >= -180 && lon <= 180) {
        position.longitude = lon;
      }
      if (position.latitude !== undefined || position.longitude !== undefined) {
        data.position = position;
      } else {
        warnings.push('position out of range');
      }

      // Trip reasons indicate motion state of the tracked asset.
      if (reason === 3 || reason === 4) {
        data.action = { motion: { detected: true } };
      } else if (reason === 5) {
        data.action = { motion: { detected: false } };
      }

      data.altitudeM = altitude;
      data.hdop = hdop;
      data.timeToFixS = ttf;
      index += 13;
    } else if (type === 3) {
      // GNSS_TIMEOUT: no fix obtained; report what diagnostics are available.
      if (bytes.length < index + 2) {
        return { errors: ['GNSS timeout record requires 2 bytes'] };
      }
      data.reason = reasonAsStr(tag >> 4);
      data.gnssTimeout = true;
      data.satellitesInView = bytes[index] & 0xff;
      data.gnssActiveTimeS = bytes[index + 1] & 0xff;
      index += 2;
    } else if (type === 5) {
      // QOS_INFO: solar quality-of-service state. Terminal record.
      if (bytes.length < index + 1) {
        return { errors: ['QoS record requires 1 byte'] };
      }
      var qos = bytes[index] & 0xff;
      var state = 'unknown';
      if (qos === 0) { state = 'Not active'; }
      else if (qos === 1) { state = 'Almost empty'; }
      else if (qos === 2) { state = 'Medium'; }
      else if (qos === 4) { state = 'Almost full'; }
      else if (qos === 8) { state = 'Night mode'; }
      data.qosState = state;
      index += 1;
      recordsSeen += 1;
      break;
    } else {
      // Unknown message type (e.g. CONFIG, EXTENDED_GNSS_DATA): stop here.
      break;
    }
    recordsSeen += 1;
  }

  if (recordsSeen === 0) {
    return { errors: ['unsupported message type (expected 0, 1, 2, 3 or 5)'] };
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}
