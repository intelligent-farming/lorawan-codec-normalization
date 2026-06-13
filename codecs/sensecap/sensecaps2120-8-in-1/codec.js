// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SenseCAP S2120 (LoRaWAN 8-in-1 Weather Station:
// air temperature, air humidity, barometric pressure, light intensity, UV index,
// wind speed, wind direction, rainfall).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire format
// understood with reference to the upstream Apache-2.0 decoder (Seeed-Solution
// SenseCAP_S2120_TTN_Decoder.js, mirrored in TheThingsNetwork/lorawan-devices
// vendor/sensecap/sensecap2120-8-in-1-decoder.js, attributed in NOTICE).
//
// NOTE: the S2120 does NOT use the 7-byte little-endian frame format of the
// SenseCAP S210x single-sensor siblings. It uses an ID-prefixed, variable-length,
// BIG-endian frame format. A packet is a sequence of frames; each frame starts
// with a 1-byte dataId that selects its layout and length:
//
//   dataId 01 (10 value bytes): air temperature (2B big-endian, signed, /10 degC),
//     air humidity (1B, %), light intensity (4B, lux), UV index (1B, /10),
//     wind speed (2B, /10 m/s). measurementIds 4097/4098/4099/4190/4105.
//   dataId 02 (8 value bytes): wind direction (2B, deg), rainfall cumulative
//     (4B, /1000 mm), barometric pressure (2B, in 0.1 hPa units).
//     measurementIds 4104/4113/4101.
//   dataId 03 (1 value byte): battery percentage.
//   dataId 04 (9 value bytes): device status — battery %, hardware version,
//     firmware version, sensor reporting interval (minutes), GPS interval
//     (minutes). We extract only battery %; versions/intervals are not telemetry.
//   dataId 05/06/10/20/21/30..45/32/34..39: interval-set / sensor-error /
//     sensor-id / reserved control frames carrying no field measurement; their
//     lengths are tracked so multi-frame packets stay aligned, but they emit no
//     normalized data.
//
// Numeric fields are big-endian; signed fields (temperature, wind speed) use
// two's complement. Barometric pressure is reported by the device in units of
// 0.1 hPa (raw 0x2703 = 9987 -> 998.7 hPa); we divide by 10 to reach the
// vocabulary unit hPa. Rainfall raw is in 0.001 mm; divide by 1000 for mm.
//
// Authored normalization (NOT upstream's array output): values are mapped onto
// the shared vocabulary by measurementId. We do not fabricate a CRC check (the
// upstream decoder performs none); instead a packet that yields no decodable
// telemetry returns an errors array.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Build a hex string (uppercase, zero-padded) from a byte array.
function bytesToHex(arr) {
  var s = '';
  for (var i = 0; i < arr.length; i++) {
    var n = arr[i];
    if (n < 0) {
      n = 256 + n;
    }
    var t = (n & 0xff).toString(16);
    if (t.length === 1) {
      t = '0' + t;
    }
    s += t;
  }
  return s.toUpperCase();
}

// Interpret a big-endian hex field as an unsigned integer.
function beUnsigned(hex) {
  return parseInt(hex, 16);
}

// Interpret a big-endian hex field as a two's-complement signed integer, then
// apply the divisor.
function beSignedScaled(hex, divisor) {
  var v = parseInt(hex, 16);
  var bits = hex.length * 4;
  // High bit set -> negative in two's complement.
  if (parseInt(hex.substring(0, 2), 16) & 0x80) {
    v = v - Math.pow(2, bits);
  }
  return v / divisor;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short for a SenseCAP S2120 frame'] };
  }

  var hex = bytesToHex(bytes);

  var data = {};
  var air = {};
  var wind = {};
  var rain = {};
  var hasAir = false;
  var hasWind = false;
  var hasRain = false;
  var hasTelemetry = false;

  var i = 0;
  while (i + 2 <= hex.length) {
    var dataId = hex.substring(i, i + 2);
    var dv;

    if (dataId === '01') {
      dv = hex.substring(i + 2, i + 22);
      if (dv.length < 20) {
        return { errors: ['truncated dataId 01 frame'] };
      }
      i += 22;
      air.temperature = round(beSignedScaled(dv.substring(0, 4), 10), 1);
      air.relativeHumidity = round(beUnsigned(dv.substring(4, 6)), 0);
      air.lightIntensity = round(beUnsigned(dv.substring(6, 14)), 0);
      // UV index is not a vocabulary key -> camelCase extra.
      data.uvIndex = round(beUnsigned(dv.substring(14, 16)) / 10, 1);
      wind.speed = round(beSignedScaled(dv.substring(16, 20), 10), 1);
      hasAir = true;
      hasWind = true;
      hasTelemetry = true;
    } else if (dataId === '02') {
      dv = hex.substring(i + 2, i + 18);
      if (dv.length < 16) {
        return { errors: ['truncated dataId 02 frame'] };
      }
      i += 18;
      wind.direction = round(beUnsigned(dv.substring(0, 4)), 0);
      rain.cumulative = round(beUnsigned(dv.substring(4, 12)) / 1000, 3);
      // Device reports pressure in 0.1 hPa units -> /10 for hPa.
      air.pressure = round(beUnsigned(dv.substring(12, 16)) / 10, 1);
      hasAir = true;
      hasWind = true;
      hasRain = true;
      hasTelemetry = true;
    } else if (dataId === '03') {
      dv = hex.substring(i + 2, i + 4);
      if (dv.length < 2) {
        return { errors: ['truncated dataId 03 frame'] };
      }
      i += 4;
      data.batteryPercent = beUnsigned(dv);
      hasTelemetry = true;
    } else if (dataId === '04') {
      dv = hex.substring(i + 2, i + 20);
      if (dv.length < 18) {
        return { errors: ['truncated dataId 04 frame'] };
      }
      i += 20;
      // Device-status frame: only the leading battery percentage is telemetry.
      data.batteryPercent = beUnsigned(dv.substring(0, 2));
      hasTelemetry = true;
    } else if (dataId === '05' || dataId === '34') {
      // Interval-set acknowledgement (4 value bytes); no field measurement.
      i += 10;
    } else if (dataId === '06') {
      // Sensor-error event (1 value byte); not a normalized measurement.
      i += 4;
    } else if (dataId === '10' || dataId === '32' || dataId === '35' ||
               dataId === '36' || dataId === '37' || dataId === '38' ||
               dataId === '39') {
      // Sensor-id / reserved (9 value bytes); no field measurement.
      i += 20;
    } else if (dataId === '20' || dataId === '21' || dataId === '30' ||
               dataId === '31' || dataId === '33' || dataId === '40' ||
               dataId === '41' || dataId === '42' || dataId === '43' ||
               dataId === '44' || dataId === '45') {
      // Reserved/extended (10 value bytes); no field measurement.
      i += 22;
    } else {
      // Unknown dataId: cannot determine frame length, so stop parsing.
      break;
    }
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasWind) {
    data.wind = wind;
  }
  if (hasRain) {
    data.rain = rain;
  }

  if (!hasTelemetry) {
    return { errors: ['no telemetry in payload'] };
  }

  return { data: data };
}
