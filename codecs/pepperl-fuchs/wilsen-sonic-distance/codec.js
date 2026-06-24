// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Pepperl+Fuchs WILSEN.sonic.distance
// (WS-UC*-F406-B17-*): an outdoor, battery-powered ultrasonic distance/proximity
// sensor that also carries an onboard GNSS receiver and reports a live GPS
// position fix. Sibling of WILSEN.sonic.level (same WILSEN wire format).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/pepperl-fuchs/wilsen.js, attributed
// in NOTICE). The upstream field extraction (a sequence of length-prefixed,
// sensor-ID-tagged TLV records) is reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream object output).
//
// Wire format: the payload is a concatenation of TLV records. Each record is
//   [len:uint8][sID:uint16-BE][value: (len-2) bytes]
// where `len` counts the sID plus value bytes; the next record starts `len+1`
// bytes later. Records this codec normalizes:
//   0201  Temperature        IEEE-754 float32 (BE) C       -> air.temperature
//   0B01  Proximity          uint16  (raw units)           -> proximity (extra)
//   0B02  Proximity in mm    uint16  mm                    -> distanceMm (extra)
//   0B06  Filling level      uint8   %                     -> fillingLevelPercent
//   0B07  Amplitude          uint8                         -> amplitude (extra)
//   0B08  Water body level   uint16  mm                    -> waterBodyLevelMm
//   5001  GPS latitude       int32   * 1e-6 deg (WGS84)    -> position.latitude
//   5002  GPS longitude      int32   * 1e-6 deg (WGS84)    -> position.longitude
//   5101  Battery            sID low byte = status; value uint8 * 0.1 V -> battery
// All other sensor IDs (serial number, counters, valve/node config, downlink
// ACKs) are device diagnostics outside this category's scope and are skipped.
//
// Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
// against a malformed record over-reading the packed fields.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function toInt32(value) {
  if (value > 0x7fffffff) {
    return value - 0x100000000;
  }
  return value;
}

// IEEE-754 single-precision (big-endian) from four byte values.
function bytesToFloat32(b0, b1, b2, b3) {
  var bits = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
  var sign = (bits >>> 31) === 0 ? 1 : -1;
  var exponent = (bits >>> 23) & 0xff;
  var fraction = bits & 0x7fffff;
  if (exponent === 0) {
    if (fraction === 0) {
      return 0;
    }
    return sign * fraction * Math.pow(2, -149);
  }
  if (exponent === 0xff) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + fraction * Math.pow(2, -23)) * Math.pow(2, exponent - 127);
}

function u16(bytes, i) {
  return (bytes[i] << 8) | bytes[i + 1];
}

function u32(bytes, i) {
  return (bytes[i] * 16777216) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['missing payload bytes'] };
  }

  var data = {};
  var warnings = [];
  var extras = {};
  var lat = null;
  var lon = null;

  var i = 0;
  while (i < bytes.length) {
    var len = bytes[i];
    if (len < 2 || i + 1 + len > bytes.length) {
      return { errors: ['malformed TLV record at byte ' + i] };
    }
    var sID = u16(bytes, i + 1);
    var v = i + 3; // first value byte

    if (sID === 0x0201) {
      data.air = data.air || {};
      data.air.temperature = round(bytesToFloat32(bytes[v], bytes[v + 1], bytes[v + 2], bytes[v + 3]), 1);
    } else if (sID === 0x0B01) {
      extras.proximity = u16(bytes, v);
    } else if (sID === 0x0B02) {
      extras.distanceMm = u16(bytes, v);
    } else if (sID === 0x0B06) {
      extras.fillingLevelPercent = bytes[v];
    } else if (sID === 0x0B07) {
      extras.amplitude = bytes[v];
    } else if (sID === 0x0B08) {
      extras.waterBodyLevelMm = u16(bytes, v);
    } else if (sID === 0x5001) {
      lat = round(toInt32(u32(bytes, v)) / 1000000, 6);
    } else if (sID === 0x5002) {
      lon = round(toInt32(u32(bytes, v)) / 1000000, 6);
    } else if (sID === 0x5101) {
      // Upstream quirk: the battery "status" is the low byte of the sID (0x01),
      // and the single value byte holds the voltage in 0.1 V steps. Only emit
      // when the status byte == 1 (a valid reading).
      if ((sID & 0xff) === 1) {
        data.battery = round(bytes[v] / 10, 1);
      }
    }
    // other sensor IDs are diagnostics/config ACKs: skipped

    i = i + 1 + len;
  }

  var position = {};
  if (lat !== null && lat >= -90 && lat <= 90) {
    position.latitude = lat;
  }
  if (lon !== null && lon >= -180 && lon <= 180) {
    position.longitude = lon;
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  } else if (lat !== null || lon !== null) {
    warnings.push('GPS coordinates out of range; suppressed');
  }

  for (var k in extras) {
    if (extras.hasOwnProperty(k)) {
      data[k] = extras[k];
    }
  }

  var keys = [];
  for (var kk in data) {
    if (data.hasOwnProperty(kk)) {
      keys.push(kk);
    }
  }
  if (keys.length === 0) {
    return { errors: ['no recognized sensor records in payload'] };
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
    result.data.make = "pepperl-fuchs";
    result.data.model = "wilsen-sonic-distance";
  }
  return result;
}
