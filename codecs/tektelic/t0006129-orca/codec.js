// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic ORCA Industrial GPS Asset Tracker
// (T0006129). Reports GPS geolocation, ground speed, GNSS fix status, an
// accelerometer (motion alarm + acceleration vector), board temperature,
// and one or two battery cells, on the data uplink fPort 10.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Tektelic two-byte header [channel, type] TLV on fPort 10, with each
// field described by a byte span plus an MSB-first bit range, big-endian) was
// ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_orca_industrial_gps_asset_tracker.js, attributed in NOTICE). The
// upstream `extractBytes` / `bytesToValue` bit-extraction semantics are
// reproduced faithfully so decoded field values match upstream exactly; only
// the JSON shape is re-authored to the normalized vocabulary (never the
// upstream decode() output).
//
// Mapping notes (fPort 10 headers):
//   - 0x00 0x88 coordinates: latitude (signed24 * 0.0000125 deg) ->
//     position.latitude; longitude (signed32 * 0.0000001 deg) ->
//     position.longitude; altitude (signed16 * 0.5 m) -> extra altitude (m).
//     Faithful to upstream, the three fields occupy a single 9-byte chunk read
//     MSB-first: altitude in the low 16 bits, longitude in the next 32, latitude
//     in the high 24. A fix is suppressed if |lat| > 90 or |lon| > 180.
//   - 0x00 0x67 temperature: signed16 * 0.1 C -> air.temperature. (Board/ambient
//     temperature; there is no separate MCU-temperature channel on this product,
//     so it is the device's single temperature reading.)
//   - 0x00 0x00 acceleration_alarm: uint8 -> action.motion.detected (boolean,
//     non-zero = motion event) and extra accelerationAlarm (raw code).
//   - 0x00 0x71 acceleration_vector: three signed16 * 0.001 g, read MSB-first
//     from a single 6-byte chunk (xaxis low 16 bits, yaxis next 16, zaxis high
//     16) exactly as upstream -> extras accelerationX/Y/Z (g).
//   - 0x00 0x92 ground_speed: uint16 * 0.1 -> extra groundSpeed.
//   - 0x00 0x95 fix_status: bit0 utc, bit1 position -> extras gpsFixUtc,
//     gpsFixPosition (booleans).
//   - 0x00 0x04 fsm_state: uint8 -> extra fsmState.
//   - 0x01 0x95 geofence_status: four 2-bit zone codes -> extras geofenceZone0..3.
//   - 0x01 0xBA / 0x02 0xBA battery1/2 status: low 7 bits -> level * 0.01 + 2.5 V
//     -> vocabulary `battery` (cell 1) / extra battery2 (cell 2, volts); bit 7 is
//     an end-of-service flag -> extras batteryEndOfService / battery2EndOfService.
//   - 0x00 0x85 utc: packed second/minute/hour/day/month/year fields surfaced as
//     camelCase extras (utcSecond ... utcYear), reproduced from the upstream bit
//     ranges; not coerced into a vocabulary `time` because the upstream packing
//     is non-calendar (wide bit spans) and unsafe to treat as RFC3339.

// Faithful port of the upstream extractBytes(): given a big-endian byte chunk,
// return the bytes covering bit positions [endBit, startBit] (bit 0 = LSB of the
// last chunk byte), MSB-first, with the top byte truncated to the field width.
function extractBytes(chunk, startBit, endBit) {
  var totalBits = startBit - endBit + 1;
  var totalBytes = totalBits % 8 === 0 ? (totalBits / 8) >>> 0 : ((totalBits / 8) >>> 0) + 1;
  var bitOffset = endBit % 8;
  var arr = new Array(totalBytes);
  for (var byte = totalBytes - 1; byte >= 0; byte--) {
    var chunkIndex = byte + (chunk.length - 1 - ((startBit / 8) | 0));
    var lo = chunk[chunkIndex] >> bitOffset;
    var hi = 0;
    if (byte !== 0) {
      var hiBitmask = (1 << bitOffset) - 1;
      var bitsFromHi = 8 - bitOffset;
      hi = chunk[chunkIndex - 1] & (hiBitmask << bitsFromHi);
    } else {
      lo = lo & ((1 << (totalBits % 8 ? totalBits % 8 : 8)) - 1);
    }
    arr[byte] = hi | lo;
  }
  return arr;
}

// Faithful port of the upstream bytesToValue() for the signed/unsigned cases.
// decimals === null means "no rounding" (raw integer/flag fields).
function bytesToValue(bytes, signed, coefficient, decimals, addition) {
  var output = 0;
  var i;
  if (signed) {
    for (i = 0; i < bytes.length; i++) {
      output = (output << 8) | bytes[i];
    }
    if (output > Math.pow(2, 8 * bytes.length - 1)) {
      output -= Math.pow(2, 8 * bytes.length);
    }
  } else {
    for (i = 0; i < bytes.length; i++) {
      output = (((output << 8) >>> 0)) | bytes[i];
    }
  }
  var v = output * coefficient + addition;
  return decimals === null ? v : Number(v.toFixed(decimals));
}

// Decode one field described by a byte chunk and a field spec.
function field(chunk, startBit, endBit, signed, coefficient, decimals, addition) {
  return bytesToValue(extractBytes(chunk, startBit, endBit), signed, coefficient, decimals, addition);
}

function hex2(n) {
  return ('0' + (n === undefined ? 0 : n & 0xff).toString(16)).slice(-2);
}

function slice(bytes, start, count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push(bytes[start + i] & 0xff);
  }
  return out;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected data uplink on fPort 10)'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var position = {};
  var air = {};
  var extras = {};
  var i = 0;

  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      return { errors: ['truncated header at byte ' + i] };
    }
    var channel = bytes[i] & 0xff;
    var type = bytes[i + 1] & 0xff;

    if (channel === 0x00 && type === 0x88) {
      // Coordinates: 9-byte chunk, MSB-first. lat (71-48), lon (47-16), alt (15-0).
      if (i + 2 + 9 > bytes.length) {
        return { errors: ['truncated coordinates field at byte ' + i] };
      }
      var c = slice(bytes, i + 2, 9);
      var lat = field(c, 71, 48, true, 0.0000125, 6, 0);
      var lon = field(c, 47, 16, true, 0.0000001, 7, 0);
      var alt = field(c, 15, 0, true, 0.5, 1, 0);
      if (lat >= -90 && lat <= 90) {
        position.latitude = lat;
      }
      if (lon >= -180 && lon <= 180) {
        position.longitude = lon;
      }
      extras.altitude = alt;
      i += 11;
    } else if (channel === 0x00 && type === 0x67) {
      // Temperature: signed16 * 0.1 C -> air.temperature.
      if (i + 2 + 2 > bytes.length) {
        return { errors: ['truncated temperature field at byte ' + i] };
      }
      air.temperature = field(slice(bytes, i + 2, 2), 15, 0, true, 0.1, 1, 0);
      i += 4;
    } else if (channel === 0x00 && type === 0x00) {
      // Acceleration alarm: uint8 -> action.motion.detected + raw code.
      if (i + 2 + 1 > bytes.length) {
        return { errors: ['truncated acceleration_alarm field at byte ' + i] };
      }
      var alarm = field(slice(bytes, i + 2, 1), 7, 0, false, 1, null, 0);
      extras.accelerationAlarm = alarm;
      if (!data.action) {
        data.action = {};
      }
      if (!data.action.motion) {
        data.action.motion = {};
      }
      data.action.motion.detected = alarm !== 0;
      i += 3;
    } else if (channel === 0x00 && type === 0x71) {
      // Acceleration vector: 6-byte chunk, MSB-first. xaxis (15-0), yaxis
      // (31-16), zaxis (47-32), each signed16 * 0.001 g.
      if (i + 2 + 6 > bytes.length) {
        return { errors: ['truncated acceleration_vector field at byte ' + i] };
      }
      var a = slice(bytes, i + 2, 6);
      extras.accelerationX = field(a, 15, 0, true, 0.001, 3, 0);
      extras.accelerationY = field(a, 31, 16, true, 0.001, 3, 0);
      extras.accelerationZ = field(a, 47, 32, true, 0.001, 3, 0);
      i += 8;
    } else if (channel === 0x00 && type === 0x92) {
      // Ground speed: uint16 * 0.1 -> extra.
      if (i + 2 + 2 > bytes.length) {
        return { errors: ['truncated ground_speed field at byte ' + i] };
      }
      extras.groundSpeed = field(slice(bytes, i + 2, 2), 15, 0, false, 0.1, 1, 0);
      i += 4;
    } else if (channel === 0x00 && type === 0x95) {
      // Fix status: bit0 utc, bit1 position -> extras (booleans).
      if (i + 2 + 1 > bytes.length) {
        return { errors: ['truncated fix_status field at byte ' + i] };
      }
      var fs = slice(bytes, i + 2, 1);
      extras.gpsFixUtc = field(fs, 0, 0, false, 1, null, 0) !== 0;
      extras.gpsFixPosition = field(fs, 1, 1, false, 1, null, 0) !== 0;
      i += 3;
    } else if (channel === 0x00 && type === 0x04) {
      // FSM state: uint8 -> extra.
      if (i + 2 + 1 > bytes.length) {
        return { errors: ['truncated fsm_state field at byte ' + i] };
      }
      extras.fsmState = field(slice(bytes, i + 2, 1), 7, 0, false, 1, null, 0);
      i += 3;
    } else if (channel === 0x01 && type === 0x95) {
      // Geofence status: four 2-bit zone codes -> extras.
      if (i + 2 + 1 > bytes.length) {
        return { errors: ['truncated geofence_status field at byte ' + i] };
      }
      var g = slice(bytes, i + 2, 1);
      extras.geofenceZone0 = field(g, 1, 0, false, 1, null, 0);
      extras.geofenceZone1 = field(g, 3, 2, false, 1, null, 0);
      extras.geofenceZone2 = field(g, 5, 4, false, 1, null, 0);
      extras.geofenceZone3 = field(g, 7, 6, false, 1, null, 0);
      i += 3;
    } else if (channel === 0x01 && type === 0xba) {
      // Battery 1 status: bits 6-0 -> level * 0.01 + 2.5 V -> battery; bit 7 EOS.
      if (i + 2 + 1 > bytes.length) {
        return { errors: ['truncated battery1_status field at byte ' + i] };
      }
      var b1 = slice(bytes, i + 2, 1);
      data.battery = field(b1, 6, 0, false, 0.01, 2, 2.5);
      extras.batteryEndOfService = field(b1, 7, 7, false, 1, null, 0) !== 0;
      i += 3;
    } else if (channel === 0x02 && type === 0xba) {
      // Battery 2 status: bits 6-0 -> level * 0.01 + 2.5 V -> extra battery2; bit 7 EOS.
      if (i + 2 + 1 > bytes.length) {
        return { errors: ['truncated battery2_status field at byte ' + i] };
      }
      var b2 = slice(bytes, i + 2, 1);
      extras.battery2 = field(b2, 6, 0, false, 0.01, 2, 2.5);
      extras.battery2EndOfService = field(b2, 7, 7, false, 1, null, 0) !== 0;
      i += 3;
    } else if (channel === 0x00 && type === 0x85) {
      // UTC timestamp: 7-byte chunk packing the calendar fields. Surfaced as
      // camelCase extras, reproduced from the upstream bit ranges.
      if (i + 2 + 7 > bytes.length) {
        return { errors: ['truncated utc field at byte ' + i] };
      }
      var u = slice(bytes, i + 2, 7);
      extras.utcSecond = field(u, 7, 0, false, 1, null, 0);
      extras.utcMinute = field(u, 15, 8, false, 1, null, 0);
      extras.utcHour = field(u, 23, 16, false, 1, null, 0);
      extras.utcDay = field(u, 31, 24, false, 1, null, 0);
      extras.utcMonth = field(u, 39, 32, false, 1, null, 0);
      extras.utcYear = field(u, 55, 40, false, 1, null, 0);
      i += 9;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' + hex2(channel) + ' 0x' + hex2(type) + ' at byte ' + i,
        ],
      };
    }
  }

  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }
  if (air.temperature !== undefined) {
    data.air = air;
  }

  var extraKeys = [];
  var k;
  for (k in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, k)) {
      extraKeys.push(k);
    }
  }
  for (var j = 0; j < extraKeys.length; j++) {
    data[extraKeys[j]] = extras[extraKeys[j]];
  }

  var hasData = false;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    return { errors: ['no decodable measurements in payload'] };
  }

  return { data: data };
}
