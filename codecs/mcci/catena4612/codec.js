// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena 4612 Node (a Catena 4610-class node:
// air temperature, relative humidity, barometric pressure and ambient light).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (port 1 sensor report, leading format byte + flag bitmap) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena-generic.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Mapping notes:
//   tempC  -> air.temperature (degC, raw is int16 with LSB 1/256 degC)
//   rh     -> air.relativeHumidity (%, raw is u8 scaled /256*100)
//   p      -> air.pressure (hPa, raw is u16 with LSB 4 Pa -> *4/100)
//   lux    -> air.lightIntensity (lux, numeric only)
//   vBat   -> battery (V; MCCI reports a signed int16 of LSB 1/4096 V, i.e.
//             already volts, so there is NO percent-vs-volts issue here)
// vBus (the bus/supply rail voltage), boot (reset counter) and the raw format
// byte are genuine device data with no vocabulary home, emitted as camelCase
// extras (vBus, boot, raw). The upstream-derived dew point (tDewC) and the
// constant "error":"none" string are NOT measurements and are dropped.
//
// Only the port 1 sensor-report formats this 4610-class node emits are decoded.
// The shared header bitmap is: 0x01 vBat, 0x02 vBus, 0x04 boot,
// 0x08 temp/pressure/RH, 0x10 lux. Higher flag bits belong to soil/water/power/
// air-quality variants the 4612 does not carry and are treated as unsupported.

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
    return { errors: ['payload too short'] };
  }

  var format = bytes[0];
  if (format !== 0x14) {
    return { errors: ['unsupported uplink format 0x' + format.toString(16)] };
  }

  var i = 1;
  var flags = bytes[i];
  i += 1;

  if (flags & 0xe0) {
    // soil/water/power/air-quality channels — not present on a 4612.
    return {
      errors: ['unsupported sensor flags 0x' + (flags & 0xe0).toString(16)]
    };
  }
  if ((flags & 0x1f) === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }

  var data = {};
  var air = {};

  if (flags & 0x01) {
    // Battery: signed int16, LSB = 1/4096 V. Already volts -> `battery`.
    data.battery = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x02) {
    // Bus/supply rail voltage: signed int16, LSB = 1/4096 V. Vendor extra.
    data.vBus = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x04) {
    // Boot/reset counter: vendor diagnostic extra.
    data.boot = bytes[i];
    i += 1;
  }

  if (flags & 0x08) {
    air.temperature = round(i16(bytes, i) / 256, 2);
    i += 2;
    air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
    i += 2;
    air.relativeHumidity = round((bytes[i] / 256) * 100, 2);
    i += 1;
  }

  if (flags & 0x10) {
    air.lightIntensity = u16(bytes, i);
    i += 2;
  }

  // Preserve the format byte as a raw vendor diagnostic extra.
  data.raw = format;

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
