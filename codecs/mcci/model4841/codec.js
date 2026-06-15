// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena Model 4841 (PMS7003-based outdoor
// environmental / particulate air-quality node: BME280-class air temperature,
// relative humidity and barometric pressure; Plantower PMS7003 particulate
// matter / dust-bin counts with a derived US-EPA PM AQI; and a TVOC reading).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCCI Catena PMS7003 flag-bitmap records: port 1 / port 5, uplink
// formats 0x20 and 0x21) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/mcci/codec-model4841.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Mapping notes:
//   t  -> air.temperature (degC; signed 16-bit count, LSB = 1/256 degC)
//   rh -> air.relativeHumidity (%; unsigned 16-bit, full-scale 65535 = 100%)
//   p  -> air.pressure (hPa; unsigned 16-bit, LSB = 4 Pa -> hPa). ATMOSPHERIC:
//         the device reports station barometric pressure (~900-1100 hPa), so it
//         maps straight to the vocabulary air.pressure. Present only in format
//         0x20; format 0x21 omits the barometer (PMS7003 without a BME280).
//   vbat -> battery (V; signed 16-bit count, LSB = 1/4096 V). The device already
//         reports volts, so it maps straight to the vocabulary battery (no
//         percent issue).
// The secondary rails (vsys, vbus) and the boot/reset counter are genuine device
// diagnostics with no vocabulary home, emitted as camelCase extras (vsys, vbus,
// boot). The PMS7003 particulate data has no vocabulary home either (the
// vocabulary only models air.co2 — see definitions/categories/air-quality.json),
// so it is emitted as extras: pm (PM1.0/2.5/10 mass concentration, ug/m3), dust
// (per-bin particle counts), aqi + aqiPartial (derived US-EPA PM AQI), and tvoc
// (raw VOC count). Derived upstream values that are not direct measurements
// (dew point tDew, heat index tHeatIndex) and the echoed port/format fields are
// dropped from the normalized output.

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

// UFLT16: 4-bit exponent, 12-bit mantissa (mantissa is a fraction of 4096).
function uflt16(raw) {
  var exp = raw >> 12;
  var mant = (raw & 0xfff) / 4096.0;
  return mant * Math.pow(2, exp - 15);
}

// Mass concentration / dust-bin counts are UFLT16 scaled by 65536 (the PMS7003
// values are integers in the device's units; the scale recovers them).
function uflt16Scaled(raw) {
  return uflt16(raw) * 65536.0;
}

// Derive a US-EPA PM AQI from a concentration (ug/m3) using the device's own
// breakpoint tables (ported from the upstream CalculatePmAqi interpolation).
function pmAqi(v, table) {
  if (v === null) {
    return null;
  }
  var idx = 0;
  var k;
  for (k = table.length - 2; k > 0; k -= 1) {
    if (table[k][0] <= v) {
      idx = k;
      break;
    }
  }
  var baseX = table[idx][0];
  var baseY = table[idx][1];
  var dx = table[idx + 1][0] - baseX;
  var f = v - baseX;
  var dy = table[idx + 1][1] - baseY;
  return Math.floor(baseY + (f * dy) / dx + 0.5);
}

function need(bytes, i, n) {
  return bytes.length - i >= n;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  if (port !== 1 && port !== 5) {
    return { errors: ['unsupported fPort ' + port] };
  }

  var format = bytes[0];
  if (format !== 0x20 && format !== 0x21) {
    return { errors: ['unsupported uplink format 0x' + format.toString(16)] };
  }
  if (bytes.length < 2) {
    return { errors: ['payload too short for format + flag byte'] };
  }

  var data = {};
  var air = {};
  var i = 1;
  var flags = bytes[i];
  i += 1;
  var hasField = false;

  // bit 0x01: battery rail (signed 16-bit count, LSB = 1/4096 V). Already volts.
  if (flags & 0x01) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading battery'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x02: system supply rail (vsys). Diagnostic extra.
  if (flags & 0x02) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading vsys'] };
    }
    data.vsys = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x04: bus / secondary rail (vbus). Diagnostic extra.
  if (flags & 0x04) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading vbus'] };
    }
    data.vbus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x08: boot/reset counter. Diagnostic extra.
  if (flags & 0x08) {
    if (!need(bytes, i, 1)) {
      return { errors: ['payload truncated reading boot'] };
    }
    data.boot = bytes[i];
    i += 1;
    hasField = true;
  }

  // bit 0x10: environment block — temperature, (format 0x20 only) barometric
  // pressure, relative humidity.
  if (flags & 0x10) {
    var envLen = format === 0x20 ? 6 : 4;
    if (!need(bytes, i, envLen)) {
      return { errors: ['payload truncated reading environment block'] };
    }
    air.temperature = round(i16(bytes, i) / 256, 4);
    i += 2;
    if (format === 0x20) {
      // Barometric (atmospheric) pressure: U16, LSB = 4 Pa -> hPa.
      air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
      i += 2;
    }
    air.relativeHumidity = round((u16(bytes, i) * 100) / 65535.0, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x20: particulate block. On port 5 it is prefixed by a 16-bit TVOC
  // count; on port 1 the TVOC arrives later in the 0x80 block instead. The
  // block then carries PM1.0/2.5/10 mass concentrations (UFLT16 * 65536) and a
  // derived US-EPA PM AQI. Particulate data has no vocabulary home -> extras.
  if (flags & 0x20) {
    var tvocLen = port === 5 ? 2 : 0;
    if (!need(bytes, i, tvocLen + 6)) {
      return { errors: ['payload truncated reading particulate block'] };
    }
    if (port === 5) {
      data.tvoc = u16(bytes, i);
      i += 2;
    }
    var pm = {};
    pm['1.0'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    pm['2.5'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    pm['10'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    data.pm = pm;

    var t25 = [
      [0, 0],
      [12.1, 51],
      [35.5, 101],
      [55.5, 151],
      [150.5, 201],
      [250.5, 301],
      [350.5, 401]
    ];
    var t10 = [
      [0, 0],
      [55, 51],
      [155, 101],
      [255, 151],
      [355, 201],
      [425, 301],
      [505, 401]
    ];
    var aqi10 = pmAqi(pm['10'], t10);
    var aqi25 = pmAqi(pm['2.5'], t25);
    var aqiPm1 = pmAqi(pm['1.0'], t25);
    data.aqiPartial = {
      '1.0': aqiPm1,
      '2.5': aqi25,
      '10': aqi10
    };
    // Overall AQI is the worse of the PM2.5 and PM10 sub-indices.
    data.aqi = aqi25 === null ? aqi10 : aqi10 === null ? aqi25 : aqi25 > aqi10 ? aqi25 : aqi10;
    hasField = true;
  }

  // bit 0x40: per-bin dust particle counts (0.3/0.5/1.0/2.5/5/10 um),
  // UFLT16 * 65536. Raw device counts -> extra.
  if (flags & 0x40) {
    if (!need(bytes, i, 12)) {
      return { errors: ['payload truncated reading dust block'] };
    }
    var dust = {};
    dust['0.3'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    dust['0.5'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    dust['1.0'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    dust['2.5'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    dust['5'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    dust['10'] = round(uflt16Scaled(u16(bytes, i)), 4);
    i += 2;
    data.dust = dust;
    hasField = true;
  }

  // bit 0x80 (port 1 only): TVOC count. Raw VOC index -> extra.
  if (flags & 0x80 && port === 1) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading tvoc'] };
    }
    data.tvoc = u16(bytes, i);
    i += 2;
    hasField = true;
  }

  var hasAir = false;
  var ak;
  for (ak in air) {
    if (air.hasOwnProperty(ak)) {
      hasAir = true;
    }
  }
  if (hasAir) {
    data.air = air;
  }

  if (!hasField) {
    return { errors: ['no sensor fields present in payload'] };
  }
  return { data: data };
}
