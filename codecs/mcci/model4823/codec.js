// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena Model 4823 (Precision Indoor
// Environmental Sensor, SHT35 temperature/humidity + Si1133 ambient light +
// BME280-class barometric pressure).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fPort 1, sensor-report format byte 0x14 followed by a flag bitmap)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena-generic.js,
// attributed in NOTICE). Author the normalization here; the upstream
// normalizeUplink is NOT copied.
//
// Mapping notes:
//   tempC  -> air.temperature (degC)
//   rh     -> air.relativeHumidity (%)
//   p      -> air.pressure (hPa; raw LSB is 4 Pa = 0.04 hPa)
//   lux    -> air.lightIntensity (lux, numeric only)
//   vBat   -> battery (V); the Catena reports a signed int16 in 1/4096 V, i.e.
//             already volts, so there is no battery-percent problem.
// Genuine device data with no vocabulary home is emitted as camelCase extras:
//   vBus (bus voltage, V), boot (reset counter), raw (the format byte).
// The upstream-derived dew point (tDewC) is NOT a measurement and is dropped.

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

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 1) {
    return { errors: ['unsupported fPort ' + port] };
  }
  if (!bytes || bytes.length < 2) {
    return { errors: ['empty payload'] };
  }

  var format = bytes[0];
  if (format !== 0x14) {
    return { errors: ['unsupported sensor-report format 0x' + format.toString(16)] };
  }

  var data = {};
  var air = {};
  var i = 1;
  var flags = bytes[i];
  i += 1;

  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }

  // Bounds-check helper expressed inline at each consume site.
  if (flags & 0x01) {
    // Battery: signed int16, LSB = 1/4096 V. Already volts -> `battery`.
    if (i + 2 > bytes.length) {
      return { errors: ['payload truncated reading battery'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x02) {
    // Bus/secondary voltage: signed int16, LSB = 1/4096 V. Vendor extra.
    if (i + 2 > bytes.length) {
      return { errors: ['payload truncated reading vBus'] };
    }
    data.vBus = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x04) {
    // Boot/reset counter: vendor diagnostic extra.
    if (i + 1 > bytes.length) {
      return { errors: ['payload truncated reading boot counter'] };
    }
    data.boot = bytes[i];
    i += 1;
  }

  if (flags & 0x08) {
    // Temperature (int16, LSB 1/256 degC), pressure (u16, LSB 4 Pa),
    // relative humidity (u8, full-scale 256 = 100%).
    if (i + 5 > bytes.length) {
      return { errors: ['payload truncated reading temperature/pressure/humidity'] };
    }
    air.temperature = round(i16(bytes, i) / 256, 2);
    i += 2;
    air.pressure = round(u16(bytes, i) * 4 / 100.0, 2);
    i += 2;
    air.relativeHumidity = round(bytes[i] / 256 * 100, 1);
    i += 1;
  }

  if (flags & 0x10) {
    // Ambient light: u16 lux -> air.lightIntensity (lux, numeric).
    if (i + 2 > bytes.length) {
      return { errors: ['payload truncated reading light'] };
    }
    air.lightIntensity = u16(bytes, i);
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

  // The format discriminator byte, retained as a raw vendor extra.
  data.raw = format;

  return { data: data };
}
