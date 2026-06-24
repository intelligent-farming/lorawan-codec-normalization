// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox RA0715 (RA07 Series modular wireless
// environmental sensor: a base node carrying one of several interchangeable
// probe modules), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/ra0715_r72615_ra0715y_r72615a.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x05 == RA07 Series) and bytes[2] the report-type
// discriminator selecting which probe module's reading the frame carries.
// reportType 0x00 is a device-info/startup frame (software / hardware version +
// datecode) and carries no measurement. For a measurement frame, bytes[3] is
// battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`); the three sensor channels are 16-bit
// big-endian values at bytes[4..5], bytes[6..7], bytes[8..9]. A channel value
// of 0xFFFF means the corresponding probe is absent ("NoSensor") and the
// channel is omitted.
//
// This codec normalizes the report types whose channels map onto the shared
// vocabulary:
//   0x07 -> CO2 (channel/10 ppm) -> air.co2 (NH3, Noise are unmodelled, dropped)
//   0x0C -> Temperature (channel/100 C, two's-complement) -> air.temperature,
//           Humidity (channel/100 %) -> air.relativeHumidity,
//           WindSpeed (channel/100 m/s) -> wind.speed
//   0x0D -> WindDirection (channel deg) -> wind.direction,
//           Atmosphere (32-bit/100 hPa) -> air.pressure
//   0x0E -> VOC (channel/10) -> camelCase extra `voc`
// Other report types (PM, particle counts, gas, water-quality, soil probes,
// etc.) carry no climate/air-quality channel and are reported as errors, as are
// config responses on fPort 7.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(hi, lo) {
  return (hi << 8) | lo;
}

// 16-bit big-endian two's-complement.
function s16(hi, lo) {
  var raw = u16(hi, lo);
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return raw;
}

// A 16-bit channel reads 0xFFFF when the probe is absent.
function present(raw) {
  return raw !== 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  var air = {};
  var wind = {};

  if (reportType === 0x07) {
    // CO2 / NH3 / Noise. Only CO2 is modelled by the vocabulary.
    var co2 = u16(bytes[4], bytes[5]);
    if (!present(co2)) {
      return { errors: ['report type 0x07 (CO2) reported no measurement'] };
    }
    air.co2 = round(co2 / 10, 1);
  } else if (reportType === 0x0c) {
    // Temperature / Humidity / WindSpeed.
    var temp = s16(bytes[4], bytes[5]);
    var humi = u16(bytes[6], bytes[7]);
    var wspd = u16(bytes[8], bytes[9]);
    if (!present(u16(bytes[4], bytes[5])) && !present(humi) && !present(wspd)) {
      return { errors: ['report type 0x0c (temperature/humidity) reported no measurement'] };
    }
    if (present(u16(bytes[4], bytes[5]))) {
      air.temperature = round(temp / 100, 2);
    }
    if (present(humi)) {
      air.relativeHumidity = round(humi / 100, 2);
    }
    if (present(wspd)) {
      wind.speed = round(wspd / 100, 2);
    }
  } else if (reportType === 0x0d) {
    // WindDirection / Atmosphere (atmospheric pressure).
    var wdir = u16(bytes[4], bytes[5]);
    var atmRaw = (bytes[6] << 24) | (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];
    var atmPresent = !(bytes[6] === 0xff && bytes[7] === 0xff && bytes[8] === 0xff && bytes[9] === 0xff);
    if (!present(wdir) && !atmPresent) {
      return { errors: ['report type 0x0d (wind direction/pressure) reported no measurement'] };
    }
    if (present(wdir)) {
      wind.direction = wdir;
    }
    if (atmPresent) {
      air.pressure = round(atmRaw / 100, 2);
    }
  } else if (reportType === 0x0e) {
    // VOC (no vocabulary key; camelCase extra).
    var voc = u16(bytes[4], bytes[5]);
    if (!present(voc)) {
      return { errors: ['report type 0x0e (VOC) reported no measurement'] };
    }
    data.voc = round(voc / 10, 1);
  } else {
    // PM / particle counts / gas / water-quality / soil probes carry no
    // climate, air-quality, wind or light channel.
    return {
      errors: ['report type 0x' + reportType.toString(16) + ' carries no normalizable measurement']
    };
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

  var hasWind = false;
  for (k in wind) {
    if (wind.hasOwnProperty(k)) {
      hasWind = true;
    }
  }
  if (hasWind) {
    data.wind = wind;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "ra0715";
  }
  return result;
}
