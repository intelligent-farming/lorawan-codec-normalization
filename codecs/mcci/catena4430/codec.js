// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena 4430 (Animal Activity Sensor:
// temperature/humidity/barometric pressure, ambient light, GPIO pellet-drop
// counters and an accelerometer activity vector).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (port 2, uplink format 0x22: GPS-epoch timestamp + flag bitmap)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-port2-fmt2.js, attributed
// in NOTICE).
//
// Mapping notes:
//   tempC -> air.temperature (degC), pressure -> air.pressure (hPa),
//   rh -> air.relativeHumidity (%), White irradiance -> air.lightIntensity
//   (lux-equivalent, numeric only), Vbat -> battery (the device already reports
//   volts as int16/4096, so no percent issue).
// Derived upstream values (dew point, heat index) are NOT measurements and are
// dropped. Genuine device data with no vocabulary home is emitted as camelCase
// extras: vSys / vBus rail voltages, boot counter, pellet-drop counters, and
// accelerometer activity samples. The accelerometer "activity" vector is a
// signed magnitude series, not a PIR/occupancy event, so it is NOT mapped to
// action.motion.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(bytes, i) {
  return ((bytes[i] << 8) + bytes[i + 1]) & 0xffff;
}

function i16(bytes, i) {
  var v = u16(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32(bytes, i) {
  return (
    bytes[i] * 16777216 +
    (bytes[i + 1] << 16) +
    (bytes[i + 2] << 8) +
    bytes[i + 3]
  );
}

function uflt16(raw) {
  var exp = raw >> 12;
  var mant = (raw & 0xfff) / 4096.0;
  return mant * Math.pow(2, exp - 15);
}

function sflt16(raw) {
  raw = raw & 0xffff;
  if (raw === 0x8000) {
    return 0;
  }
  var sign = (raw & 0x8000) !== 0 ? -1 : 1;
  var exp = (raw >> 11) & 0xf;
  var mant = (raw & 0x7ff) / 2048.0;
  return sign * mant * Math.pow(2, exp - 15);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 2) {
    return { errors: ['unsupported fPort ' + port] };
  }
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var format = bytes[0];
  if (format !== 0x22) {
    return { errors: ['unsupported uplink format 0x' + format.toString(16)] };
  }
  if (bytes.length < 6) {
    return { errors: ['payload too short for header'] };
  }

  var data = {};
  var air = {};
  var i = 1;

  // GPS-epoch seconds -> POSIX (GPS epoch offset 315964800, minus 17 leap
  // seconds), rendered as RFC3339 UTC.
  var gps = u32(bytes, i);
  i += 4;
  data.time = new Date((gps + 315964800 - 17) * 1000).toISOString();

  var flags = bytes[i];
  i += 1;

  if (flags & 0x01) {
    // Battery: signed 16-bit, LSB = 1/4096 V. Already volts -> `battery`.
    data.battery = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x02) {
    // System rail voltage (int16/4096 V): vendor diagnostic extra.
    data.vSys = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x04) {
    // USB/bus rail voltage (int16/4096 V): vendor diagnostic extra.
    data.vBus = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x08) {
    // Boot/reset counter: vendor diagnostic extra.
    data.boot = bytes[i];
    i += 1;
  }

  if (flags & 0x10) {
    // Environment block: temperature, pressure, relative humidity.
    air.temperature = round(i16(bytes, i) / 256, 2);
    i += 2;
    // Barometric pressure: U16, LSB = 4 Pa -> hPa (/100).
    air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
    i += 2;
    air.relativeHumidity = round((u16(bytes, i) * 100) / 65535.0, 1);
    i += 2;
  }

  if (flags & 0x20) {
    // White-channel irradiance (UFLT16), scaled to a lux-equivalent value.
    air.lightIntensity = round(uflt16(u16(bytes, i)) * Math.pow(2, 24), 2);
    i += 2;
  }

  if (flags & 0x40) {
    // Two GPIO pellet-drop counters: { total, delta }. Raw device counters.
    var pellets = [];
    var p;
    for (p = 0; p < 2; p++) {
      pellets.push({ total: u16(bytes, i), delta: bytes[i + 2] });
      i += 3;
    }
    data.pellets = pellets;
  }

  if (flags & 0x80) {
    // Accelerometer activity samples, SFLT16 in (-1, 1). Raw device data.
    var activity = [];
    while (bytes.length - i >= 2) {
      activity.push(round(sflt16(u16(bytes, i)), 4));
      i += 2;
    }
    data.activity = activity;
  }

  var hasAir = false;
  var k;
  for (k in air) {
    if (air.hasOwnProperty(k)) {
      hasAir = true;
    }
  }
  if (hasAir) {
    data.air = air;
  }

  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }

  return { data: data };
}
