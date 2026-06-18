// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec TRACK+ (outdoor air-quality monitoring
// station: temperature, humidity, atmospheric pressure, CO2, particulate
// matter (PM1/PM2.5/PM10), optional ozone/NO2, GPS geolocation, and a battery /
// product-status frame).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec TRACK+ frame: product byte 0xB5, message-type byte, then a
// per-message body) was ported from and normalized against the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices vendor/nexelec/track.js,
// attributed in NOTICE). The upstream field extraction (hex-string substring /
// shift slicing) is reproduced faithfully; only the JSON shape is re-authored
// to the normalized vocabulary (never the upstream normalizeUplink output).
//
// Four message types share product byte 0xB5:
//   0x01 Periodic Data        — TLV channels (1 channel byte + 2 data bytes)
//   0x02 Product Status       — hw/sw revision, battery voltage, power source
//   0x03 Positionning Frame   — GPS fix as packed degrees/minutes/seconds/ms
//   0x04 Product Configuration— device settings (not a measurement; ignored)
//
// Periodic TLV channels (channel byte -> field), value 2 bytes big-endian:
//   0x07 temperature  code/10 - 30 °C   -> air.temperature
//   0x08 humidity     code/10 %RH       -> air.relativeHumidity
//   0x09 pressure     code hPa          -> air.pressure
//   0x0A co2          code ppm          -> air.co2
//   0x01 PM1 mass     code ug/m3        -> pm1UgM3 (extra)
//   0x02 PM2.5 mass   code ug/m3        -> pm2_5UgM3 (extra)
//   0x03 PM10 mass    code ug/m3        -> pm10UgM3 (extra)
//   0x17 ozone        code ppb          -> ozonePpb (extra)
//   0x18 NO2          code ppb          -> no2Ppb (extra)
// (Particle-count channels 0x04/0x05/0x06/0x13/0x14 exist in the upstream
// frame; they are decoded as pcs/cm3 extras when present.)
//
// Sentinels (16-bit fields): 65535 = error, 65534 = disconnected sensor. At
// either sentinel the channel is suppressed rather than emitted.
//
// Product Status: batteryVoltage is millivolts (65535 = error) -> battery (V).
//
// Positionning: latitude/longitude arrive as packed degrees/minutes/seconds/
// (10 ms) plus a North/South and East/West sign bit, extracted with the
// upstream substring/shift slicing. We convert the components to signed decimal
// degrees (deg + min/60 + sec/3600 + (ms/1000)/3600, negated for South/West)
// and emit position.latitude / position.longitude. A reading is suppressed when
// the converted magnitude falls outside the valid range (|lat| > 90,
// |lon| > 180), which guards against the upstream slicing over-reading a field.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    s += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

// A 16-bit periodic channel is "absent" at 65534 (disconnected) or 65535 (error).
function present16(code) {
  return code < 65534;
}

function dmsToDecimal(deg, min, sec, ms) {
  return deg + min / 60 + sec / 3600 + ms / 1000 / 3600;
}

function decodePeriodic(hex) {
  var data = {};
  var air = {};

  // TLV walk: body starts at hex offset 4 (after 0xB5 product + msg-type byte).
  // Each entry is a 1-byte channel + 2-byte big-endian value = 6 hex chars.
  var i = 4;
  while (i + 6 <= hex.length) {
    var channel = parseInt(hex.substring(i, i + 2), 16) & 0xff;
    var value = parseInt(hex.substring(i + 2, i + 6), 16) & 0xffff;

    if (channel === 0x07) {
      if (present16(value)) {
        air.temperature = round(value / 10 - 30, 1);
      }
    } else if (channel === 0x08) {
      if (present16(value)) {
        air.relativeHumidity = round(value / 10, 1);
      }
    } else if (channel === 0x09) {
      if (present16(value)) {
        air.pressure = value;
      }
    } else if (channel === 0x0a) {
      if (present16(value)) {
        air.co2 = value;
      }
    } else if (channel === 0x01) {
      if (present16(value)) {
        data.pm1UgM3 = value;
      }
    } else if (channel === 0x02) {
      if (present16(value)) {
        data.pm2_5UgM3 = value;
      }
    } else if (channel === 0x03) {
      if (present16(value)) {
        data.pm10UgM3 = value;
      }
    } else if (channel === 0x13) {
      if (present16(value)) {
        data.pm1CountPcsCm3 = value;
      }
    } else if (channel === 0x04) {
      if (present16(value)) {
        data.pm2_5CountPcsCm3 = value;
      }
    } else if (channel === 0x05) {
      if (present16(value)) {
        data.pm10CountPcsCm3 = value;
      }
    } else if (channel === 0x14) {
      if (present16(value)) {
        data.pm0_5CountPcsCm3 = value;
      }
    } else if (channel === 0x06) {
      if (present16(value)) {
        data.pm5CountPcsCm3 = value;
      }
    } else if (channel === 0x17) {
      if (present16(value)) {
        data.ozonePpb = value;
      }
    } else if (channel === 0x18) {
      if (present16(value)) {
        data.no2Ppb = value;
      }
    }
    i = i + 6;
  }

  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.pressure !== undefined ||
    air.co2 !== undefined
  ) {
    data.air = air;
  }

  return data;
}

function decodeStatus(hex) {
  var data = {};

  var swCode = parseInt(hex.substring(6, 8), 16) & 0xff;
  var batteryMv = parseInt(hex.substring(8, 12), 16) & 0xffff;
  var powerSourceBit = (parseInt(hex.substring(16, 18), 16) >> 3) & 0x01;

  data.hardwareVersion = parseInt(hex.substring(4, 6), 16) & 0xff;
  data.softwareVersion = round(swCode * 0.1, 1);

  // batteryVoltage is millivolts (65535 = error); normalize to volts.
  if (batteryMv !== 65535) {
    data.battery = round(batteryMv / 1000, 3);
  }

  data.powerSource = powerSourceBit === 0 ? 'external' : 'battery';

  return data;
}

function decodePosition(hex) {
  var data = {};

  // Ported verbatim from the upstream positionning slicing (overlapping
  // substring + shift extraction of the packed DMS components).
  var latDeg = (parseInt(hex.substring(4, 6), 16) >> 1) & 0x7f;
  var latMin = (parseInt(hex.substring(4, 8), 16) >> 3) & 0x3f;
  var latSec = (parseInt(hex.substring(7, 9), 16) >> 1) & 0x3f;
  var latMs = ((parseInt(hex.substring(8, 11), 16) >> 2) & 0x7f) * 10;
  var latSouth = (parseInt(hex.substring(10, 11), 16) >> 1) & 0x01;

  var lonDeg = (parseInt(hex.substring(10, 13), 16) >> 1) & 0xff;
  var lonMin = (parseInt(hex.substring(12, 15), 16) >> 3) & 0x3f;
  var lonSec = (parseInt(hex.substring(14, 16), 16) >> 1) & 0x3f;
  var lonMs = ((parseInt(hex.substring(15, 18), 16) >> 2) & 0x7f) * 10;
  var lonWest = (parseInt(hex.substring(16, 18), 16) >> 1) & 0x01;

  var satellites = (parseInt(hex.substring(19, 21), 16) >> 1) & 0x1f;

  var lat = dmsToDecimal(latDeg, latMin, latSec, latMs);
  if (latSouth === 1) {
    lat = -lat;
  }
  var lon = dmsToDecimal(lonDeg, lonMin, lonSec, lonMs);
  if (lonWest === 1) {
    lon = -lon;
  }

  var position = {};
  // Suppress out-of-range fixes (guards against the upstream slicing over-reading).
  if (lat >= -90 && lat <= 90) {
    position.latitude = round(lat, 6);
  }
  if (lon >= -180 && lon <= 180) {
    position.longitude = round(lon, 6);
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }

  data.satellites = satellites;

  return data;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short for a Nexelec TRACK+ frame'] };
  }

  var hex = bytesToHex(bytes);
  var product = parseInt(hex.substring(0, 2), 16);
  var messageType = parseInt(hex.substring(2, 4), 16);

  if (product !== 0xb5) {
    return { errors: ['unexpected product byte (expected 0xB5 for Nexelec TRACK+)'] };
  }

  if (messageType === 0x01) {
    return { data: decodePeriodic(hex) };
  }
  if (messageType === 0x02) {
    return { data: decodeStatus(hex) };
  }
  if (messageType === 0x03) {
    return { data: decodePosition(hex) };
  }
  if (messageType === 0x04) {
    // Product Configuration carries device settings, not measurements.
    return { errors: ['product configuration frame carries no normalized measurement'] };
  }

  return { errors: ['unsupported message type (expected 0x01-0x04)'] };
}
