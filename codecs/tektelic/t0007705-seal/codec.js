// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic SEAL Wearable Safety & GPS Tracker
// (T0007705). Reports a GNSS position fix (latitude/longitude/altitude), ground
// speed, a 3-axis accelerometer vector, ambient temperature, barometric
// pressure, battery lifetime, a UTC timestamp, GNSS dead-zone status, and a
// safety-event status word (emergency button / free-fall / shock-impact /
// extended-absence-of-readings / pressure threshold).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Tektelic two-byte header [channel, type] TLV on fPort 10, big-endian
// fields) was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic decoder_seal.js, attributed
// in NOTICE). Author the normalization here; the upstream generic
// table-driven decode output is NOT copied.
//
// PORTING NOTE — upstream is broken for this device. The upstream decoder is a
// generic engine that overloads the field-table `multiple` attribute as BOTH a
// scale factor AND a structural "is this a repeating array?" flag. As a result:
//   - temperature (0x00 0x67) and barometric_pressure (0x00 0x73), whose true
//     scale lives in `multiple` (0.1), decode to the literal array `[0]`;
//   - the accelerometer (0x00 0x71) throws a TypeError and aborts the whole
//     frame;
//   - the sub-byte bitfields (gnss_status 0x00 0x95, safety_status 0x02 0x95)
//     always read 0 regardless of input.
// Only the GPS coordinates path (0x00 0x88), ground_speed, gnss_fix and the
// battery-lifetime fields decode correctly upstream. Per AUTHORING.md we author
// the correct extraction from the documented field table (the real scale is
// whichever of coefficient/multiple is populated, plus addition, then rounded
// to the stated decimals) rather than reproducing the upstream bugs. The GPS
// path here is byte-for-byte consistent with the working upstream output.
//
// Mapping (fPort 10 data uplink):
//   0x00 0xD3 battery_lifetime_pct  uint8                        -> batteryPercent (extra; % not volts)
//   0x00 0xBD battery_lifetime_dys  uint16                       -> batteryDaysRemaining (extra)
//   0x00 0x85 utc                   packed Y/M/D h:m:s           -> time (RFC3339)
//   0x00 0x88 coordinates           int24 lat *1.07e-5,
//                                   int24 lon *2.15e-5,
//                                   uint16 alt *0.144958496 -500  -> position.latitude / position.longitude
//                                                                    + altitudeMeters (extra)
//   0x00 0x92 ground_speed          uint8 *0.27778 m/s           -> groundSpeed (extra; tracker speed, not wind)
//   0x00 0x00 gnss_fix              uint8                        -> gpsFix (extra)
//   0x00 0x95 gnss_status           4x 2-bit dead-zone fields    -> gnssDeadZone0..3 (extras)
//   0x00 0x73 barometric_pressure   uint16 *0.1 hPa              -> air.pressure
//   0x00 0x74 cal_barometric_press  uint16 *0.1 hPa              -> calibratedPressure (extra)
//   0x00 0x71 acceleration x/y/z    3x int16 *0.001 g            -> accelerationX/Y/Z (extras; raw vector, not motion)
//   0x00 0x67 temperature           int16 *0.1 C                 -> air.temperature
//   0x02 0x95 safety_status         bits eb/fall/sh/ear/press    -> action.motion.detected (real motion: free-fall
//                                                                    or shock-impact) + per-flag extras
//
// Motion semantics: action.motion.detected is true only on a genuine motion
// event reported by the safety word -- free-fall (bit 1) or shock-impact
// (bit 2). The emergency-button, extended-absence and pressure-threshold flags
// are not motion and are surfaced as extras. The raw accelerometer vector is
// likewise NOT treated as motion detection.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first).
function uintBE(bytes, offset, length) {
  var out = 0;
  for (var i = 0; i < length; i++) {
    out = out * 256 + (bytes[offset + i] & 0xff);
  }
  return out;
}

// Big-endian signed (two's complement) integer from a byte slice.
function intBE(bytes, offset, length) {
  var out = uintBE(bytes, offset, length);
  var max = Math.pow(2, 8 * length);
  if (out >= max / 2) {
    out -= max;
  }
  return out;
}

function hex2(n) {
  return ('0' + (n === undefined ? 0 : n).toString(16)).slice(-2);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function decodeUplinkCore(input) {
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
  var motion = null;
  var i = 0;

  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      return { errors: ['truncated header at byte ' + i] };
    }
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xd3) {
      // Battery lifetime percentage: uint8 % -> extra (not volts).
      if (i + 3 > bytes.length) { return { errors: ['truncated battery_lifetime_pct at byte ' + i] }; }
      extras.batteryPercent = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x00 && type === 0xbd) {
      // Battery lifetime remaining: uint16 days -> extra.
      if (i + 4 > bytes.length) { return { errors: ['truncated battery_lifetime_dys at byte ' + i] }; }
      extras.batteryDaysRemaining = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x00 && type === 0x85) {
      // UTC timestamp: 4 bytes packed bitfields.
      if (i + 6 > bytes.length) { return { errors: ['truncated utc at byte ' + i] }; }
      var w = uintBE(bytes, i + 2, 4);
      var year = 2000 + ((w / 67108864) & 0x3f);
      var month = (w / 4194304) & 0x0f;
      var day = (w / 131072) & 0x1f;
      var hour = (w / 4096) & 0x1f;
      var minute = (w / 64) & 0x3f;
      var second = w & 0x3f;
      data.time = year + '-' + pad2(month) + '-' + pad2(day) + 'T' +
        pad2(hour) + ':' + pad2(minute) + ':' + pad2(second) + 'Z';
      i += 6;
    } else if (channel === 0x00 && type === 0x88) {
      // GPS coordinates: int24 lat, int24 lon, uint16 altitude.
      if (i + 10 > bytes.length) { return { errors: ['truncated coordinates at byte ' + i] }; }
      var lat = round(intBE(bytes, i + 2, 3) * 1.07e-5, 7);
      var lon = round(intBE(bytes, i + 5, 3) * 2.15e-5, 7);
      var alt = round(uintBE(bytes, i + 8, 2) * 0.144958496 - 500, 2);
      if (lat >= -90 && lat <= 90) { position.latitude = lat; }
      if (lon >= -180 && lon <= 180) { position.longitude = lon; }
      extras.altitudeMeters = alt;
      i += 10;
    } else if (channel === 0x00 && type === 0x92) {
      // Ground speed: uint8 * 0.27778 m/s -> extra (tracker speed, not wind).
      if (i + 3 > bytes.length) { return { errors: ['truncated ground_speed at byte ' + i] }; }
      extras.groundSpeed = round(uintBE(bytes, i + 2, 1) * 0.27778, 3);
      i += 3;
    } else if (channel === 0x00 && type === 0x00) {
      // GNSS fix flag: uint8 -> extra.
      if (i + 3 > bytes.length) { return { errors: ['truncated gnss_fix at byte ' + i] }; }
      extras.gpsFix = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x00 && type === 0x95) {
      // GNSS dead-zone status: 4 x 2-bit fields in one byte.
      if (i + 3 > bytes.length) { return { errors: ['truncated gnss_status at byte ' + i] }; }
      var gs = bytes[i + 2] & 0xff;
      extras.gnssDeadZone0 = gs & 0x03;
      extras.gnssDeadZone1 = (gs >> 2) & 0x03;
      extras.gnssDeadZone2 = (gs >> 4) & 0x03;
      extras.gnssDeadZone3 = (gs >> 6) & 0x03;
      i += 3;
    } else if (channel === 0x00 && type === 0x73) {
      // Barometric pressure: uint16 * 0.1 hPa -> air.pressure.
      if (i + 4 > bytes.length) { return { errors: ['truncated barometric_pressure at byte ' + i] }; }
      air.pressure = round(uintBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x00 && type === 0x74) {
      // Calibrated barometric pressure: uint16 * 0.1 hPa -> extra.
      if (i + 4 > bytes.length) { return { errors: ['truncated cal_barometric_pressure at byte ' + i] }; }
      extras.calibratedPressure = round(uintBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x00 && type === 0x71) {
      // Accelerometer x/y/z: three int16 * 0.001 g -> extras (raw vector).
      if (i + 8 > bytes.length) { return { errors: ['truncated acceleration at byte ' + i] }; }
      extras.accelerationX = round(intBE(bytes, i + 2, 2) * 0.001, 3);
      extras.accelerationY = round(intBE(bytes, i + 4, 2) * 0.001, 3);
      extras.accelerationZ = round(intBE(bytes, i + 6, 2) * 0.001, 3);
      i += 8;
    } else if (channel === 0x00 && type === 0x67) {
      // Ambient temperature: int16 * 0.1 C -> air.temperature.
      if (i + 4 > bytes.length) { return { errors: ['truncated temperature at byte ' + i] }; }
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x02 && type === 0x95) {
      // Safety status word: 1 byte of event bits.
      if (i + 3 > bytes.length) { return { errors: ['truncated safety_status at byte ' + i] }; }
      var ss = bytes[i + 2] & 0xff;
      var emergencyButton = (ss & 0x01) !== 0;
      var freeFall = (ss & 0x02) !== 0;
      var shockImpact = (ss & 0x04) !== 0;
      var extendedAbsence = (ss & 0x08) !== 0;
      var pressureAlarm = (ss & 0x10) !== 0;
      // Real motion only: free-fall or shock-impact event.
      motion = { detected: freeFall || shockImpact };
      extras.emergencyButton = emergencyButton;
      extras.freeFall = freeFall;
      extras.shockImpact = shockImpact;
      extras.extendedAbsence = extendedAbsence;
      extras.pressureAlarm = pressureAlarm;
      i += 3;
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
  if (air.temperature !== undefined || air.pressure !== undefined) {
    data.air = air;
  }
  if (motion !== null) {
    if (data.action === undefined) { data.action = {}; }
    data.action.motion = motion;
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t0007705-seal";
  }
  return result;
}
