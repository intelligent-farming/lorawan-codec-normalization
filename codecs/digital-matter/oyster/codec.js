// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Digital Matter Oyster (LoRaWAN GPS asset
// tracker: GNSS position fix, ground speed and heading, battery voltage, and
// in-trip / man-down motion state, plus device statistics and downlink acks).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/digital-matter/oyster.js, attributed
// in NOTICE). The upstream field extraction (fixed little-endian binary layout)
// is reproduced faithfully; only the JSON shape is re-authored to the
// normalized vocabulary (never the upstream Object.assign output).
//
// The Oyster multiplexes four frame types onto LoRaWAN FPorts:
//   fPort 1  Position update (full)    — int32 LE lat/lon * 1e-7
//   fPort 2  Downlink acknowledgement  — sequence / accepted / firmware version
//   fPort 3  Device statistics         — counters and averages (no fix)
//   fPort 4  Position update (compact)  — int24 LE lat/lon * 256e-7
//
// Position frames (1 and 4):
//   latitude/longitude are signed decimal degrees (WGS84).
//   inTrip   bit -> action.motion.detected (the unit is moving / on a trip).
//   fixFailed bit: when set, the carried lat/lon are a STALE cached fix, not a
//     live GNSS solution. We do NOT publish position.* in that case (it would
//     misrepresent a cached coordinate as a fresh fix); the stale coordinates
//     are surfaced as cachedLatitude / cachedLongitude extras with a warning.
//   batV     -> battery (volts).
//   speedKmph / headingDeg / fixFailed / manDown -> camelCase extras.
//
// Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed frame over-reading the packed fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodePosition1(bytes) {
  var lat = bytes[0] + bytes[1] * 256 + bytes[2] * 65536 + bytes[3] * 16777216;
  if (lat >= 0x80000000) {
    lat -= 0x100000000;
  }
  lat = lat / 1e7;

  var lon = bytes[4] + bytes[5] * 256 + bytes[6] * 65536 + bytes[7] * 16777216;
  if (lon >= 0x80000000) {
    lon -= 0x100000000;
  }
  lon = lon / 1e7;

  return {
    lat: lat,
    lon: lon,
    inTrip: (bytes[8] & 0x1) !== 0,
    fixFailed: (bytes[8] & 0x2) !== 0,
    manDown: null,
    headingDeg: round((bytes[8] >> 2) * 5.625, 3),
    speedKmph: bytes[9],
    batV: round(bytes[10] * 0.025, 2)
  };
}

function decodePosition4(bytes) {
  var lat = bytes[0] + bytes[1] * 256 + bytes[2] * 65536;
  if (lat >= 0x800000) {
    lat -= 0x1000000;
  }
  lat = lat * 256e-7;

  var lon = bytes[3] + bytes[4] * 256 + bytes[5] * 65536;
  if (lon >= 0x800000) {
    lon -= 0x1000000;
  }
  lon = lon * 256e-7;

  return {
    lat: round(lat, 7),
    lon: round(lon, 7),
    inTrip: (bytes[8] & 0x1) !== 0,
    fixFailed: (bytes[8] & 0x2) !== 0,
    manDown: (bytes[8] & 0x4) !== 0,
    headingDeg: (bytes[6] & 0x7) * 45,
    speedKmph: (bytes[6] >> 3) * 5,
    batV: round(bytes[7] * 0.025, 2)
  };
}

function buildPosition(p) {
  var data = {};
  var warnings = [];

  data.battery = p.batV;
  data.action = { motion: { detected: p.inTrip } };
  data.headingDeg = p.headingDeg;
  data.speedKmph = p.speedKmph;
  data.fixFailed = p.fixFailed;
  if (p.manDown !== null) {
    data.manDown = p.manDown;
  }

  var lat = round(p.lat, 7);
  var lon = round(p.lon, 7);
  var latOk = lat >= -90 && lat <= 90;
  var lonOk = lon >= -180 && lon <= 180;

  if (p.fixFailed) {
    // Stale cached coordinates — do not present as a live fix.
    warnings.push('fix failed');
    if (latOk) {
      data.cachedLatitude = lat;
    }
    if (lonOk) {
      data.cachedLongitude = lon;
    }
  } else {
    var position = {};
    if (latOk) {
      position.latitude = lat;
    }
    if (lonOk) {
      position.longitude = lon;
    }
    if (position.latitude !== undefined || position.longitude !== undefined) {
      data.position = position;
    }
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

function decodeAck(bytes) {
  return {
    data: {
      sequence: bytes[0] & 0x7f,
      accepted: (bytes[0] & 0x80) !== 0,
      firmwareMajor: bytes[1],
      firmwareMinor: bytes[2]
    }
  };
}

function decodeStats(bytes) {
  return {
    data: {
      battery: round(4.0 + 0.1 * (bytes[0] & 0xf), 1),
      txCount: 32 * ((bytes[0] >> 4) + (bytes[1] & 0x7f) * 16),
      tripCount: 32 * ((bytes[1] >> 7) + (bytes[2] & 0xff) * 2 + (bytes[3] & 0x0f) * 512),
      gpsSuccesses: 32 * ((bytes[3] >> 4) + (bytes[4] & 0x3f) * 16),
      gpsFails: 32 * ((bytes[4] >> 6) + (bytes[5] & 0x3f) * 4),
      aveGpsFixS: (bytes[5] >> 6) + (bytes[6] & 0x7f) * 4,
      aveGpsFailS: (bytes[6] >> 7) + (bytes[7] & 0xff) * 2,
      aveGpsFreshenS: bytes[8] & 0xff,
      wakeupsPerTrip: bytes[9] & 0x7f,
      uptimeWeeks: (bytes[9] >> 7) + (bytes[10] & 0xff) * 2
    }
  };
}

function decodeUplinkCore(input) {
  var port = input.fPort;
  var bytes = input.bytes;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (port === 1) {
    if (bytes.length < 11) {
      return { errors: ['fPort 1 position frame requires 11 bytes'] };
    }
    return buildPosition(decodePosition1(bytes));
  }
  if (port === 4) {
    if (bytes.length < 9) {
      return { errors: ['fPort 4 position frame requires 9 bytes'] };
    }
    return buildPosition(decodePosition4(bytes));
  }
  if (port === 2) {
    if (bytes.length < 3) {
      return { errors: ['fPort 2 downlink ack requires 3 bytes'] };
    }
    return decodeAck(bytes);
  }
  if (port === 3) {
    if (bytes.length < 11) {
      return { errors: ['fPort 3 stats frame requires 11 bytes'] };
    }
    return decodeStats(bytes);
  }

  return { errors: ['unsupported FPort (expected 1-4)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "digital-matter";
    result.data.model = "oyster";
  }
  return result;
}
