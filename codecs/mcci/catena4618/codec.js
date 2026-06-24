// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena 4618 (temperature / humidity /
// ambient-light node).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (port 3/6 flag-bitmap messages) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcci/codec-catena4618.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping notes:
//   t   -> air.temperature (degC, t = int16 / 256)
//   rh  -> air.relativeHumidity (%, rh = u16 / 65535 * 100)
//   lux -> air.lightIntensity (lux; port 6 SFLT24 with explicit MSB)
//   Vbat (signed int16 / 4096) -> battery (VOLTS; the device already reports
//   volts, so no battery-percent issue).
// Genuine device data with no vocabulary home is emitted as camelCase extras:
//   VDD -> vdd (V), Vbus -> vBus (V), boot counter -> boot, and on port 3 the
//   raw IR / White / UV irradiance counts -> irradiance.
// Upstream-derived dew point (tDew) and heat index (tHeatIndexC) are computed,
// not measured, and are dropped. Port-3 irradiance is raw counts (not lux), so
// it is NOT mapped to air.lightIntensity.

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

// Port-6 lux: 3-byte float, bit 23 sign, bits 22..16 exponent, bits 15..0
// mantissa with an explicit (non-IEEE) MSB.
function lux24(b0, b1, b2) {
  var raw = (b0 << 16) + (b1 << 8) + b2;
  var bSign = (raw & 0x800000) !== 0;
  var uExp = (raw & 0x7f0000) >> 16;
  var uMant = raw & 0x00ffff;
  if (uExp === 0x7f) {
    return 0; // non-numeric (Inf/NaN) — clamp to 0 lux
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
    if (i + 2 > bytes.length) {
      return { errors: ['payload truncated reading battery'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x02) {
    // System supply voltage VDD: signed 16-bit, LSB = 1/4096 V. Vendor extra.
    if (i + 2 > bytes.length) {
      return { errors: ['payload truncated reading vdd'] };
    }
    data.vdd = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x04) {
    // Boot/reset counter: vendor diagnostic extra.
    if (i + 1 > bytes.length) {
      return { errors: ['payload truncated reading boot'] };
    }
    data.boot = bytes[i];
    i += 1;
  }

  if (flags & 0x08) {
    // Temperature (int16 / 256, degC) and relative humidity (u16 / 65535 * 100).
    if (i + 4 > bytes.length) {
      return { errors: ['payload truncated reading temperature/humidity'] };
    }
    air.temperature = round(i16(bytes, i) / 256.0, 2);
    i += 2;
    air.relativeHumidity = round((u16(bytes, i) * 100) / 65535.0, 1);
    i += 2;
  }

  if (flags & 0x10) {
    if (port === 6) {
      // Ambient light, SFLT24 lux.
      if (i + 3 > bytes.length) {
        return { errors: ['payload truncated reading light'] };
      }
      air.lightIntensity = round(lux24(bytes[i], bytes[i + 1], bytes[i + 2]), 2);
      i += 3;
    } else {
      // Port 3: raw IR / White / UV irradiance counts (NOT lux). Vendor extra.
      if (i + 6 > bytes.length) {
        return { errors: ['payload truncated reading irradiance'] };
      }
      data.irradiance = {
        ir: u16(bytes, i),
        white: u16(bytes, i + 2),
        uv: u16(bytes, i + 4)
      };
      i += 6;
    }
  }

  if (flags & 0x20) {
    // External bus voltage Vbus: signed 16-bit, LSB = 1/4096 V. Vendor extra.
    if (i + 2 > bytes.length) {
      return { errors: ['payload truncated reading vBus'] };
    }
    data.vBus = round(i16(bytes, i) / 4096.0, 3);
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
    result.data.model = "catena4618";
  }
  return result;
}
