// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena® 4618 M201 Node (temperature /
// humidity, ambient light/lux, with battery, boot counter and bus/system
// voltage diagnostics).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCCI port-3/6 flag-bitmap message; no discriminator byte)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena4618m201.js,
// attributed in NOTICE).
//
// Mapping notes:
//   t   -> air.temperature (degC; int16, LSB = 1/256 degC)
//   rh  -> air.relativeHumidity (%; u16 scaled by 100/65535)
//   lux -> air.lightIntensity (lux; port 6 carries the 3-byte MCCI float)
//   Vbat (int16, LSB = 1/4096 V) -> battery (the device reports VOLTS, so no
//        percent issue).
// MCCI derived values (dew point tDew, heat index tHeatIndexC) are NOT
// measurements and are dropped. Genuine device data with no vocabulary home is
// emitted as camelCase extras: boot counter (boot), system voltage (vdd),
// bus voltage (vBus), and — on port 3 — the raw IR/White/UV irradiance
// triple (irradiance). Port 3 carries irradiance instead of lux; port 6
// carries lux.

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

// MCCI 3-byte float used for lux on port 6: bit 23 sign, bits 22..16 exponent,
// bits 15..0 explicit-msb mantissa. uExp === 0x7f is non-numeric (Inf/NaN);
// clamp to 0 lux.
function mcciLux24(b0, b1, b2) {
  var raw = (b0 << 16) + (b1 << 8) + b2;
  var bSign = (raw & 0x800000) !== 0;
  var uExp = (raw & 0x7f0000) >> 16;
  var uMant = raw & 0x00ffff;
  if (uExp === 0x7f) {
    return 0;
  }
  if (uExp !== 0) {
    uMant += 0x010000;
  } else {
    uExp = 1;
  }
  var m = (uMant / 0x010000) * Math.pow(2, uExp - 63);
  return bSign ? -m : m;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 3 && port !== 6) {
    return { errors: ['unsupported fPort ' + port] };
  }
  if (!bytes || bytes.length < 1) {
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

  if (flags & 0x01) {
    // Battery: signed 16-bit, LSB = 1/4096 V. Already volts -> `battery`.
    if (bytes.length < i + 2) {
      return { errors: ['payload too short for battery field'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  if (flags & 0x02) {
    // System (VDD) voltage: signed 16-bit, LSB = 1/4096 V. Vendor diagnostic.
    if (bytes.length < i + 2) {
      return { errors: ['payload too short for vdd field'] };
    }
    data.vdd = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  if (flags & 0x04) {
    // Boot/reset counter: vendor diagnostic extra.
    if (bytes.length < i + 1) {
      return { errors: ['payload too short for boot field'] };
    }
    data.boot = bytes[i];
    i += 1;
  }

  if (flags & 0x08) {
    // Temperature (int16, LSB = 1/256 degC) and relative humidity (u16).
    if (bytes.length < i + 4) {
      return { errors: ['payload too short for temperature/humidity field'] };
    }
    air.temperature = round(i16(bytes, i) / 256, 2);
    i += 2;
    air.relativeHumidity = round((u16(bytes, i) * 100) / 65535.0, 2);
    i += 2;
  }

  if (flags & 0x10) {
    if (port === 3) {
      // IR / White / UV irradiance counts (raw vendor data).
      if (bytes.length < i + 6) {
        return { errors: ['payload too short for irradiance field'] };
      }
      data.irradiance = {
        ir: u16(bytes, i),
        white: u16(bytes, i + 2),
        uv: u16(bytes, i + 4)
      };
      i += 6;
    } else {
      // Port 6: ambient light, MCCI 3-byte float lux -> air.lightIntensity.
      if (bytes.length < i + 3) {
        return { errors: ['payload too short for lux field'] };
      }
      air.lightIntensity = round(mcciLux24(bytes[i], bytes[i + 1], bytes[i + 2]), 4);
      i += 3;
    }
  }

  if (flags & 0x20) {
    // Bus voltage: signed 16-bit, LSB = 1/4096 V. Vendor diagnostic.
    if (bytes.length < i + 2) {
      return { errors: ['payload too short for vBus field'] };
    }
    data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
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

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcci";
    result.data.model = "catena4618m201";
  }
  return result;
}
