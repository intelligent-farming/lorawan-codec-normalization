// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena 4460 (air-quality node: BME680-class
// temperature/humidity/barometric pressure plus an indoor-air-quality / VOC gas
// sensor, ambient lux, and battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCCI flag-bitmap formats on port 1 — 0x11/0x14/0x15/0x16/0x17 — and
// the discriminator-less port 2 / port 3 simple-sensor formats) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena-generic.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// The 4460's distinguishing format is 0x17 (AQI): it extends the 0x14 4450 base
// with an indoor-air-quality index, VOC gas resistance, and an air-quality flag.
//
// Mapping notes:
//   tempC -> air.temperature (degC), rh -> air.relativeHumidity (%),
//   p -> air.pressure (hPa), lux -> air.lightIntensity (lux, numeric only).
//   vBat is a signed 16-bit count, LSB = 1/4096 V -> battery (V; the device
//   already reports volts, so no percent issue).
// Derived upstream values (dewpoint tDewC, the "error" string) are NOT
// measurements and are dropped. Genuine device data with no vocabulary home is
// emitted as camelCase extras: boot counter, the secondary bus/VDD voltage
// (vBus), the indoor-air-quality index (iaq) and its quality flag (iaqQuality),
// the VOC gas resistance (logRGas / rGas), one-wire water/soil temperatures and
// soil humidity, energy/pulse counters, raw multi-channel irradiance, and the
// Rayco water-pressure/level pair.

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

function uflt16(raw) {
  var exp = raw >> 12;
  var mant = (raw & 0xfff) / 4096.0;
  return mant * Math.pow(2, exp - 15);
}

function need(bytes, i, n) {
  return bytes.length - i >= n;
}

// Decode a port-1 message that begins with a format discriminator byte. Returns
// { data: object } or { errors: array }.
function decodePort1(bytes) {
  var cmd = bytes[0];
  if (
    cmd !== 0x11 &&
    cmd !== 0x14 &&
    cmd !== 0x15 &&
    cmd !== 0x16 &&
    cmd !== 0x17
  ) {
    return { errors: ['unsupported port 1 format 0x' + cmd.toString(16)] };
  }
  if (bytes.length < 2) {
    return { errors: ['payload too short for format + flag byte'] };
  }

  var data = {};
  var air = {};
  var i = 1;
  var flags = bytes[i];
  i += 1;

  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }

  // 0x11 (Catena 4410) packs its fields one bit lower than the other formats:
  // it has no boot byte, so flag 0x4 carries the env block, 0x8 the lux, etc.
  var is4410 = cmd === 0x11;

  // Battery voltage (all formats, flag 0x1).
  if (flags & 0x1) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading battery'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  // Secondary bus / VDD voltage (flag 0x2). Vendor diagnostic extra.
  if (flags & 0x2) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading vBus'] };
    }
    data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  var bootBit = is4410 ? 0 : 0x4;
  var envBit = is4410 ? 0x4 : 0x8;
  var luxBit = is4410 ? 0x8 : 0x10;
  var auxBit = is4410 ? 0x10 : 0x20;
  var aux2Bit = is4410 ? 0x20 : 0x40;

  // Boot/reset counter (formats with a boot byte). Vendor diagnostic extra.
  if (bootBit && flags & bootBit) {
    if (!need(bytes, i, 1)) {
      return { errors: ['payload truncated reading boot'] };
    }
    data.boot = bytes[i];
    i += 1;
  }

  // Environment block: temperature, barometric pressure, relative humidity.
  if (flags & envBit) {
    if (!need(bytes, i, 5)) {
      return { errors: ['payload truncated reading environment block'] };
    }
    air.temperature = round(i16(bytes, i) / 256, 4);
    i += 2;
    // Barometric pressure: U16, LSB = 4 Pa -> hPa.
    air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
    i += 2;
    // Relative humidity: 8-bit fraction of 256 -> percent.
    air.relativeHumidity = round((bytes[i] / 256) * 100, 4);
    i += 1;
  }

  // Ambient light (lux), numeric only.
  if (flags & luxBit) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading lux'] };
    }
    air.lightIntensity = u16(bytes, i);
    i += 2;
  }

  // Format-specific auxiliary fields.
  if (cmd === 0x17) {
    // Indoor air-quality index (UFLT16 scaled by 512). Extra: no vocabulary home.
    if (flags & 0x20) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading iaq'] };
      }
      data.iaq = round(uflt16(u16(bytes, i)) * 512, 4);
      i += 2;
    }
    // VOC gas resistance: log10(ohms) and ohms. Extras.
    if (flags & 0x40) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading gas resistance'] };
      }
      var logGasR = uflt16(u16(bytes, i)) * 16;
      i += 2;
      data.logRGas = round(logGasR, 6);
      data.rGas = round(Math.pow(10, logGasR), 4);
    }
    // Air-quality status flags (low 2 bits = quality). Extra.
    if (flags & 0x80) {
      if (!need(bytes, i, 1)) {
        return { errors: ['payload truncated reading air-quality flags'] };
      }
      data.iaqQuality = bytes[i] & 3;
      i += 1;
    }
  } else if (cmd === 0x15 || is4410) {
    // 4450 M102 / 4410: one-wire water temperature, then soil temp + humidity.
    if (flags & auxBit) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading water temperature'] };
      }
      data.waterTemperature = round(i16(bytes, i) / 256, 4);
      i += 2;
    }
    if (flags & aux2Bit) {
      if (!need(bytes, i, 3)) {
        return { errors: ['payload truncated reading soil block'] };
      }
      data.soilTemperature = round(i16(bytes, i) / 256, 4);
      i += 2;
      data.soilHumidity = round((bytes[i] / 256) * 100, 4);
      i += 1;
    }
  } else if (cmd === 0x14) {
    // 4450 M101: energy/pulse counters. Raw device counters (extras).
    if (flags & auxBit) {
      if (!need(bytes, i, 4)) {
        return { errors: ['payload truncated reading power counters'] };
      }
      data.powerUsedCount = u16(bytes, i);
      i += 2;
      data.powerSourcedCount = u16(bytes, i);
      i += 2;
    }
    if (flags & aux2Bit) {
      if (!need(bytes, i, 4)) {
        return { errors: ['payload truncated reading power rates'] };
      }
      data.powerUsedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 4);
      i += 2;
      data.powerSourcedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 4);
      i += 2;
    }
  } else if (cmd === 0x16) {
    // 4450 water level: Rayco analog water-pressure sensor. Extras.
    if (flags & aux2Bit) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading water pressure'] };
      }
      // hPa -> kPa, then derive head height (m) from rho*g.
      var wPressureKPa = ((u16(bytes, i) * 4) / 100.0) / 10;
      i += 2;
      data.waterPressure = round(wPressureKPa, 4);
      data.waterLevel = round((wPressureKPa * 1000) / (1000 * 9.81), 4);
    }
  }

  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.pressure !== undefined ||
    air.lightIntensity !== undefined
  ) {
    data.air = air;
  }

  return { data: data };
}

// Decode a port-2 / port-3 simple-sensor message. These have no discriminator
// byte; the payload begins with the flag bitmap. Port 3 omits barometric
// pressure and uses a 16-bit humidity field.
function decodeSimple(bytes, hasPressure) {
  if (bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var i = 0;
  var flags = bytes[i];
  i += 1;

  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }

  if (flags & 0x1) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading battery'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  // System supply voltage (VDD). Vendor diagnostic extra.
  if (flags & 0x2) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading VDD'] };
    }
    data.vdd = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  if (flags & 0x4) {
    if (!need(bytes, i, 1)) {
      return { errors: ['payload truncated reading boot'] };
    }
    data.boot = bytes[i];
    i += 1;
  }

  if (flags & 0x8) {
    if (hasPressure) {
      if (!need(bytes, i, 5)) {
        return { errors: ['payload truncated reading environment block'] };
      }
      air.temperature = round(i16(bytes, i) / 256, 4);
      i += 2;
      air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
      i += 2;
      air.relativeHumidity = round((bytes[i] / 256) * 100, 4);
      i += 1;
    } else {
      if (!need(bytes, i, 4)) {
        return { errors: ['payload truncated reading environment block'] };
      }
      air.temperature = round(i16(bytes, i) / 256, 4);
      i += 2;
      air.relativeHumidity = round((u16(bytes, i) / 65535) * 100, 4);
      i += 2;
    }
  }

  // Multi-channel irradiance (IR / White / UV), raw calibrated counts. Extra.
  if (flags & 0x10) {
    if (!need(bytes, i, 6)) {
      return { errors: ['payload truncated reading irradiance'] };
    }
    data.irradiance = {
      ir: u16(bytes, i),
      white: u16(bytes, i + 2),
      uv: u16(bytes, i + 4)
    };
    i += 6;
  }

  if (flags & 0x20) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading vBus'] };
    }
    data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.pressure !== undefined
  ) {
    data.air = air;
  }

  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  if (port === 1) {
    return decodePort1(bytes);
  }
  if (port === 2) {
    return decodeSimple(bytes, true);
  }
  if (port === 3) {
    return decodeSimple(bytes, false);
  }
  return { errors: ['unsupported fPort ' + port] };
}
