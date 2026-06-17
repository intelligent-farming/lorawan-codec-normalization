// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R72615A (R726/RA07-series wireless
// multi-sensor platform), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/netvox/payload/ra0715_r72615_ra0715y_r72615a.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// fPort 6 carries periodic data reports: bytes[0] is the frame version,
// bytes[1] the device type (0x09 == R726 Series) and bytes[2] the report-type
// discriminator. reportType 0x00 is a device-info/startup frame (software /
// hardware version + datecode) and carries no measurement. For a measurement
// frame, bytes[3] is battery voltage in 0.1 V (high bit flags low battery,
// surfaced as the camelCase extra `lowBattery`), and bytes[4..9] carry up to
// three 16-bit big-endian sensor channels whose meaning is selected by the
// report type. A channel reading of 0xFFFF (or 0xFF / 0xFFFFFFFF for the 8-bit
// and 32-bit channels) is the "no sensor" sentinel and is omitted rather than
// emitted.
//
// The R72615A is the climate/CO2 variant of this platform, but the upstream
// decoder (source of truth) is the shared multi-sensor decoder, so this codec
// ports every report type faithfully. Values that map onto the normalized
// vocabulary are emitted as vocabulary keys: temperature -> air.temperature,
// humidity -> air.relativeHumidity, CO2 -> air.co2, wind speed -> wind.speed,
// wind direction -> wind.direction, and the 5TE / generic soil channels ->
// soil.moisture / soil.temperature / soil.ec. Everything the vocabulary does
// not model (particulates, gas concentrations, water-quality probes, VOC,
// atmospheric raw counter, etc.) is surfaced as a camelCase extra.
//
// Config responses (fPort 7) carry no measurement; any other fPort is unknown.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// 16-bit big-endian two's-complement, scaled to `decimals` places.
function signed16(hi, lo, decimals) {
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return round(raw / Math.pow(10, decimals), decimals);
}

// 0xFF / 0xFFFF / 0xFFFFFFFF are the "no sensor present" sentinels upstream.
function present(val) {
  return val !== 0xff && val !== 0xffff && val !== 0xffffffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['unsupported fPort 7 (config response, no measurement)'] };
  }
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

  // The three primary 16-bit channels.
  var c1 = (bytes[4] << 8) | bytes[5];
  var c2 = (bytes[6] << 8) | bytes[7];
  var c3 = (bytes[8] << 8) | bytes[9];

  var air = {};
  var wind = {};
  var soil = {};

  if (reportType === 0x01 || reportType === 0x02) {
    // Particulate matter (ug/m3). Not in the vocabulary -> extras.
    if (present(c1)) data.pm1_0 = c1;
    if (present(c2)) data.pm2_5 = c2;
    if (present(c3)) data.pm10 = c3;
  } else if (reportType === 0x03) {
    if (present(c1)) data.um0_3 = c1;
    if (present(c2)) data.um0_5 = c2;
    if (present(c3)) data.um1_0 = c3;
  } else if (reportType === 0x04) {
    if (present(c1)) data.um2_5 = c1;
    if (present(c2)) data.um5_0 = c2;
    if (present(c3)) data.um10 = c3;
  } else if (reportType === 0x05) {
    if (present(c1)) data.o3 = round(c1 / 10, 1);
    if (present(c2)) data.co = round(c2 / 10, 1);
    if (present(c3)) data.no = round(c3 / 10, 1);
  } else if (reportType === 0x06) {
    if (present(c1)) data.no2 = round(c1 / 10, 1);
    if (present(c2)) data.so2 = round(c2 / 10, 1);
    if (present(c3)) data.h2s = round(c3 / 10, 1);
  } else if (reportType === 0x07) {
    // CO2 (ppm) -> vocabulary air.co2; NH3 / Noise are extras.
    if (present(c1)) air.co2 = round(c1 / 10, 1);
    if (present(c2)) data.nh3 = round(c2 / 10, 1);
    if (present(c3)) data.noise = round(c3 / 10, 1);
  } else if (reportType === 0x08) {
    if (present(c1)) data.pH = round(c1 / 100, 2);
    if (present(c2)) data.tempPH = signed16(bytes[6], bytes[7], 2);
    if (present(c3)) {
      // ORP is a signed integer (mV), not scaled.
      var orp = c3;
      if (orp & 0x8000) orp = orp - 0x10000;
      data.orp = orp;
    }
  } else if (reportType === 0x09) {
    if (present(c1)) data.ntu = round(c1 / 10, 1);
    if (present(c2)) data.tempNTU = signed16(bytes[6], bytes[7], 2);
    if (present(c3)) data.ec5SoilHumi = round(c3 / 100, 2);
  } else if (reportType === 0x0a) {
    // METER 5TE soil probe -> normalized soil keys.
    if (present(c1)) soil.moisture = round(c1 / 100, 2);
    if (present(c2)) soil.temperature = signed16(bytes[6], bytes[7], 2);
    if (present(c3)) data.waterLevel = c3;
    if (present(bytes[10])) data.ec5TE = round(bytes[10] / 10, 1);
  } else if (reportType === 0x0b) {
    if (present(c1)) data.tempLDO = signed16(bytes[4], bytes[5], 2);
    if (present(c2)) data.ldoDO = round(c2 / 100, 2);
    if (present(c3)) data.ldoSat = round(c3 / 10, 1);
  } else if (reportType === 0x0c) {
    // Temperature / humidity / wind speed.
    if (present(c1)) air.temperature = signed16(bytes[4], bytes[5], 2);
    if (present(c2)) air.relativeHumidity = round(c2 / 100, 2);
    if (present(c3)) wind.speed = round(c3 / 100, 2);
  } else if (reportType === 0x0d) {
    if (present(c1)) wind.direction = c1;
    // 32-bit atmospheric raw counter; unit is unclear and out of the
    // air.pressure (hPa) range, so surface it as an extra.
    var atm = (bytes[6] << 24) | (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];
    if (atm < 0) atm = atm + 0x100000000;
    if (atm !== 0xffffffff) data.atmosphere = round(atm / 100, 2);
  } else if (reportType === 0x0e) {
    if (present(c1)) data.voc = round(c1 / 10, 1);
  } else if (reportType === 0x0f) {
    if (present(c1)) data.nitrogen = c1;
    if (present(c2)) data.phosphorus = c2;
    if (present(c3)) data.potassium = c3;
  } else if (reportType === 0x10) {
    // Generic soil probe -> normalized soil keys (EC in dS/m, /1000 from uS/cm).
    if (present(c1)) soil.moisture = round(c1 / 100, 2);
    if (present(c2)) soil.temperature = signed16(bytes[6], bytes[7], 2);
    if (present(c3)) soil.ec = round(c3 / 1000, 3);
  } else {
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no measurement'] };
  }

  var hasAir = false;
  var k;
  for (k in air) {
    if (Object.prototype.hasOwnProperty.call(air, k)) hasAir = true;
  }
  if (hasAir) data.air = air;

  var hasWind = false;
  for (k in wind) {
    if (Object.prototype.hasOwnProperty.call(wind, k)) hasWind = true;
  }
  if (hasWind) data.wind = wind;

  var hasSoil = false;
  for (k in soil) {
    if (Object.prototype.hasOwnProperty.call(soil, k)) hasSoil = true;
  }
  if (hasSoil) data.soil = soil;

  return { data: data };
}
