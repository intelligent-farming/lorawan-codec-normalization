// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox RA0715Y (Wireless Outdoor
// CO2/Temperature/Humidity Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/ra0715_r72615_ra0715y_r72615a.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x0D == "RA07**Y Series"), and bytes[2] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software/hardware version + datecode) and carries no measurement. For a
// measurement frame, bytes[3] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`); the three primary
// sensor channels are 16-bit big-endian fields at bytes[4..5], bytes[6..7],
// bytes[8..9]. The RA07xxY platform multiplexes many physical sub-sensors onto
// the same frame layout keyed by reportType; this device's cataloged sensors
// are CO2 (reportType 0x07 -> air.co2), and temperature + humidity
// (reportType 0x0C -> air.temperature / air.relativeHumidity). Other
// reportTypes (particulates, gases, soil, pH, turbidity, dissolved oxygen,
// wind, VOC) are decoded to vocabulary keys where one exists (soil.*, wind.*)
// or camelCase extras otherwise, since the vocabulary does not model them. A
// channel reading of 0xFF / 0xFFFF / 0xFFFFFFFF is the device's "no sensor
// fitted" sentinel and is omitted from the output. Config responses (fPort 7)
// carry no measurement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Device "no sensor fitted" sentinel for the 8/16/32-bit channels.
function sensorMissing(val) {
  return val === 0xff || val === 0xffff || val === 0xffffffff;
}

// 16-bit big-endian, signed via the high bit (two's-complement).
function signed16(hi, lo) {
  var raw = ((hi << 8) | lo) & 0xffff;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return raw;
}

function hasKeys(obj) {
  var k;
  for (k in obj) {
    if (obj.hasOwnProperty(k)) {
      return true;
    }
  }
  return false;
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

  // The three primary 16-bit big-endian sensor channels.
  var ch1 = (bytes[4] << 8) | bytes[5];
  var ch2 = (bytes[6] << 8) | bytes[7];
  var ch3 = (bytes[8] << 8) | bytes[9];

  var air = {};
  var soil = {};
  var wind = {};

  if (reportType === 0x01 || reportType === 0x02) {
    // Particulate mass concentration (ug/m3): PM1.0 / PM2.5 / PM10.
    if (!sensorMissing(ch1)) data.pm1_0 = ch1;
    if (!sensorMissing(ch2)) data.pm2_5 = ch2;
    if (!sensorMissing(ch3)) data.pm10 = ch3;
  } else if (reportType === 0x03) {
    // Particle number concentration: >0.3 / >0.5 / >1.0 um.
    if (!sensorMissing(ch1)) data.um0_3 = ch1;
    if (!sensorMissing(ch2)) data.um0_5 = ch2;
    if (!sensorMissing(ch3)) data.um1_0 = ch3;
  } else if (reportType === 0x04) {
    // Particle number concentration: >2.5 / >5.0 / >10 um.
    if (!sensorMissing(ch1)) data.um2_5 = ch1;
    if (!sensorMissing(ch2)) data.um5_0 = ch2;
    if (!sensorMissing(ch3)) data.um10 = ch3;
  } else if (reportType === 0x05) {
    // Gas concentrations (ppm): O3 / CO / NO, each scaled 0.1.
    if (!sensorMissing(ch1)) data.o3 = round(ch1 / 10, 1);
    if (!sensorMissing(ch2)) data.co = round(ch2 / 10, 1);
    if (!sensorMissing(ch3)) data.no = round(ch3 / 10, 1);
  } else if (reportType === 0x06) {
    // Gas concentrations (ppm): NO2 / SO2 / H2S, each scaled 0.1.
    if (!sensorMissing(ch1)) data.no2 = round(ch1 / 10, 1);
    if (!sensorMissing(ch2)) data.so2 = round(ch2 / 10, 1);
    if (!sensorMissing(ch3)) data.h2s = round(ch3 / 10, 1);
  } else if (reportType === 0x07) {
    // CO2 (ppm, scaled 0.1) plus NH3 (ppm) and acoustic noise.
    if (!sensorMissing(ch1)) air.co2 = round(ch1 / 10, 1);
    if (!sensorMissing(ch2)) data.nh3 = round(ch2 / 10, 1);
    if (!sensorMissing(ch3)) data.noise = round(ch3 / 10, 1);
  } else if (reportType === 0x08) {
    // pH probe: pH (0.01), probe temperature (0.01 C, signed), ORP (mV, signed).
    if (!sensorMissing(ch1)) data.ph = round(ch1 / 100, 2);
    if (!sensorMissing(ch2)) data.phTemperature = round(signed16(bytes[6], bytes[7]) / 100, 2);
    if (!sensorMissing(ch3)) data.orp = signed16(bytes[8], bytes[9]);
  } else if (reportType === 0x09) {
    // Turbidity (NTU, 0.1), probe temperature (0.01 C, signed), EC5 soil humidity (0.01).
    if (!sensorMissing(ch1)) data.turbidity = round(ch1 / 10, 1);
    if (!sensorMissing(ch2)) data.turbidityTemperature = round(signed16(bytes[6], bytes[7]) / 100, 2);
    if (!sensorMissing(ch3)) data.ec5SoilHumidity = round(ch3 / 100, 2);
  } else if (reportType === 0x0a) {
    // 5TE soil probe: VWC (0.01 %), soil temperature (0.01 C, signed),
    // water level, plus EC (0.1) in byte[10].
    if (!sensorMissing(ch1)) soil.moisture = round(ch1 / 100, 2);
    if (!sensorMissing(ch2)) soil.temperature = round(signed16(bytes[6], bytes[7]) / 100, 2);
    if (!sensorMissing(ch3)) data.waterLevel = ch3;
    if (!sensorMissing(bytes[10])) data.ec5te = round(bytes[10] / 10, 1);
  } else if (reportType === 0x0b) {
    // Luminescent dissolved oxygen: temperature (0.01 C, signed), DO (0.01 mg/L), saturation (0.1 %).
    if (!sensorMissing(ch1)) data.doTemperature = round(signed16(bytes[4], bytes[5]) / 100, 2);
    if (!sensorMissing(ch2)) data.dissolvedOxygen = round(ch2 / 100, 2);
    if (!sensorMissing(ch3)) data.doSaturation = round(ch3 / 10, 1);
  } else if (reportType === 0x0c) {
    // Air temperature (0.01 C, signed), relative humidity (0.01 %), wind speed (0.01 m/s).
    if (!sensorMissing(ch1)) air.temperature = round(signed16(bytes[4], bytes[5]) / 100, 2);
    if (!sensorMissing(ch2)) air.relativeHumidity = round(ch2 / 100, 2);
    if (!sensorMissing(ch3)) wind.speed = round(ch3 / 100, 2);
  } else if (reportType === 0x0d) {
    // Wind direction (deg) plus a 32-bit atmospheric pressure field (0.01 kPa).
    if (!sensorMissing(ch1)) wind.direction = ch1;
    var atm = ((bytes[6] << 24) | (bytes[7] << 16) | (bytes[8] << 8) | bytes[9]) >>> 0;
    if (!sensorMissing(atm)) data.atmosphere = round(atm / 100, 2);
  } else if (reportType === 0x0e) {
    // Total VOC (ppm, scaled 0.1).
    if (!sensorMissing(ch1)) data.tvoc = round(ch1 / 10, 1);
  } else if (reportType === 0x0f) {
    // Soil NPK (ppm).
    if (!sensorMissing(ch1)) soil.n = ch1;
    if (!sensorMissing(ch2)) soil.p = ch2;
    if (!sensorMissing(ch3)) soil.k = ch3;
  } else if (reportType === 0x10) {
    // Soil: VWC (0.01 %), temperature (0.01 C, signed), EC (uS/cm -> dS/m).
    if (!sensorMissing(ch1)) soil.moisture = round(ch1 / 100, 2);
    if (!sensorMissing(ch2)) soil.temperature = round(signed16(bytes[6], bytes[7]) / 100, 2);
    if (!sensorMissing(ch3)) soil.ec = round(ch3 / 1000, 3);
  } else {
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no measurement'] };
  }

  if (hasKeys(air)) data.air = air;
  if (hasKeys(soil)) data.soil = soil;
  if (hasKeys(wind)) data.wind = wind;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "ra0715y";
  }
  return result;
}
