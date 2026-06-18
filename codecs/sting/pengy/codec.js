// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Sting Pengy (air-climate / air-quality node:
// temperature + humidity on every firmware, plus pressure, particulate-matter,
// gas and noise channels on later firmwares).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (big-endian fixed-layout frame, one layout per fPort / firmware
// version) was ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/sting/pengy-decoder.js, attributed
// in NOTICE). The upstream byte slicing, scaling factors, signed-temperature
// trick (bytes[2] << 24 >> 16 | bytes[3]), range gates, humidity clamp+warning,
// and EAQI lookup are reproduced exactly:
//
//   fPort 1 (fw 1.0): humidity, temperature, RPM, FPM, EAQI
//   fPort 2 (fw 1.5): the fw-1.0 fields + pressure, CO, NH3, NO2, noise
//   fPort 3 (fw 2.0): humidity, temperature, pressure, UPM/FPM/RPM, noise, EAQI
//
// Vocabulary mapping:
//   humidity     -> air.relativeHumidity (%)
//   temperature  -> air.temperature (°C)
//   pressure     -> air.pressure (hPa; vocabulary bound 900..1100)
// The Pengy reports CO/NH3/NO2 (not CO2), particulate matter, an EAQI air-index
// label, an acoustic noise level and a firmware version string. None of these
// has a vocabulary key, so each is emitted as a camelCase extra (co, nh3, no2,
// pm1/pm25/pm10, noise, eaqi, version).
//
// Faithfulness note: upstream sets an out-of-range channel to `null` and still
// returns it. The normalized vocabulary keys must be numbers, so a value that
// fails its range gate is SUPPRESSED here (omitted) rather than emitted as
// null, while the upstream humidity clamp warning is preserved verbatim.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Unsigned big-endian 16-bit.
function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// Signed big-endian 16-bit, reproducing upstream's `hi << 24 >> 16 | lo`.
function s16be(hi, lo) {
  return ((hi << 24) >> 16) | lo;
}

// EAQI label lookup, ported verbatim from upstream getEAQI(pm1, pm25, pm10).
// Only pm25 (fine PM) and pm10 (coarse PM) drive the index upstream.
function getEAQI(pm25, pm10) {
  var eaqi = 'NaN';
  if (pm25 >= 75 || pm10 >= 150) {
    eaqi = 'Extremely poor';
  } else if ((pm25 >= 50 && pm25 < 75) || (pm10 >= 100 && pm10 < 150)) {
    eaqi = 'Very poor';
  } else if ((pm25 >= 25 && pm25 < 50) || (pm10 >= 50 && pm10 < 100)) {
    eaqi = 'Poor';
  } else if ((pm25 >= 20 && pm25 < 25) || (pm10 >= 40 && pm10 < 50)) {
    eaqi = 'Moderate';
  } else if ((pm25 >= 10 && pm25 < 20) || (pm10 >= 20 && pm10 < 40)) {
    eaqi = 'Fair';
  } else if ((pm25 >= 0 && pm25 < 10) || (pm10 >= 0 && pm10 < 20)) {
    eaqi = 'Good';
  } else {
    eaqi = 'Unknown';
  }
  return eaqi;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 1 && fPort !== 2 && fPort !== 3) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 1, 2 or 3)'] };
  }

  var minLen = fPort === 1 ? 8 : fPort === 2 ? 18 : 14;
  if (!bytes || bytes.length < minLen) {
    return { errors: ['payload too short for Sting Pengy fPort ' + fPort] };
  }

  var data = {};
  var air = {};
  var warnings = [];

  if (fPort === 1 || fPort === 2 || fPort === 3) {
    var hum = round(0.1 * u16be(bytes[0], bytes[1]), 1);
    var tem = round(0.1 * s16be(bytes[2], bytes[3]), 1);

    if (hum > 100.0) {
      warnings.push('Humidity out of range (' + hum + ')');
      hum = 100.0;
    }
    if (!(hum < 0.0 || hum > 100.0)) {
      air.relativeHumidity = hum;
    }
    if (!(tem < -50.0 || tem > 100.0)) {
      air.temperature = tem;
    }
  }

  // fw 1.0 (fPort 1) and fw 1.5 (fPort 2) share the same RPM/FPM layout.
  if (fPort === 1 || fPort === 2) {
    var rpm = round(0.1 * u16be(bytes[4], bytes[5]), 0);
    var fpm = round(0.1 * u16be(bytes[6], bytes[7]), 0);
    if (!(rpm < 0 || rpm > 5000)) {
      data.rpm = rpm;
    }
    if (!(fpm < 0 || fpm > 5000)) {
      data.fpm = fpm;
    }
    data.eaqi = getEAQI(fpm, rpm);
  }

  // fw 1.5 (fPort 2) adds pressure, gases and noise.
  if (fPort === 2) {
    var pre2 = round(u16be(bytes[8], bytes[9]), 0);
    var co = round(1.0 * u16be(bytes[10], bytes[11]), 0);
    var nh3 = round(1.0 * u16be(bytes[12], bytes[13]), 0);
    var no2 = round(0.01 * u16be(bytes[14], bytes[15]), 2);
    var noise2 = round(0.01 * u16be(bytes[16], bytes[17]), 2);

    if (!(pre2 < 900 || pre2 > 1100)) {
      air.pressure = pre2;
    }
    if (!(co < 0.0 || co > 10000)) {
      data.co = co;
    }
    if (!(nh3 < 0.0 || nh3 > 10000)) {
      data.nh3 = nh3;
    }
    if (!(no2 < 0.0 || no2 > 10000)) {
      data.no2 = no2;
    }
    data.noise = noise2;
    data.version = '1.5';
  } else if (fPort === 1) {
    data.version = '1.0';
  }

  // fw 2.0 (fPort 3): pressure, three PM channels and noise.
  if (fPort === 3) {
    var pre3 = round(u16be(bytes[4], bytes[5]), 0);
    var pm1 = round(0.1 * u16be(bytes[6], bytes[7]), 0);
    var pm25 = round(0.1 * u16be(bytes[8], bytes[9]), 0);
    var pm10 = round(0.1 * u16be(bytes[10], bytes[11]), 0);
    var noise3 = round(0.01 * u16be(bytes[12], bytes[13]), 2);

    if (!(pre3 < 900 || pre3 > 1100)) {
      air.pressure = pre3;
    }
    if (!(pm1 < 0 || pm1 > 5000)) {
      data.pm1 = pm1;
    }
    if (!(pm25 < 0 || pm25 > 5000)) {
      data.pm25 = pm25;
    }
    if (!(pm10 < 0 || pm10 > 5000)) {
      data.pm10 = pm10;
    }
    data.noise = noise3;
    data.eaqi = getEAQI(pm25, pm10);
    data.version = '2.0';
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined || air.pressure !== undefined) {
    data.air = air;
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}
