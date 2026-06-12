// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena 4610 (indoor temperature, humidity,
// barometric pressure and ambient-light node).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (port 1 flag-bitmap records, formats 0x11/0x14/0x15/0x16/0x17, plus the
// discriminator-less port 2 / port 3 records) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcci/codec-catena-generic.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping notes:
//   tempC -> air.temperature (degC), rh -> air.relativeHumidity (%),
//   p -> air.pressure (hPa), lux -> air.lightIntensity (lux, numeric only),
//   vBat -> battery (V; the device reports a signed int16 in 1/4096 V, already
//   volts, so there is no battery-percent issue).
// Derived upstream values (dew point `tDewC`) and the cosmetic `error: "none"`
// string are NOT measurements and are dropped. Genuine device data with no
// vocabulary home is emitted as camelCase extras: boot counter (boot), bus/
// supply voltage (vBus, vdd, both volts), and the IR/White/UV irradiance
// channel counts (irradiance) carried by the port 2 / port 3 light records.

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

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var i;
  var flags;

  if (port === 1) {
    var format = bytes[0];
    if (
      format !== 0x11 &&
      format !== 0x14 &&
      format !== 0x15 &&
      format !== 0x16 &&
      format !== 0x17
    ) {
      return { errors: ['unsupported uplink format 0x' + format.toString(16)] };
    }
    if (bytes.length < 2) {
      return { errors: ['payload too short for header'] };
    }

    i = 1;
    flags = bytes[i];
    i += 1;

    // Format 0x11 has no boot byte and shifts the remaining flag bits down by
    // one relative to the 0x14/0x15/0x16/0x17 family; normalize to a common
    // set of booleans so the body below is shared.
    var hasVBat;
    var hasVBus;
    var hasBoot;
    var hasEnv;
    var hasLux;
    if (format === 0x11) {
      hasVBat = (flags & 0x01) !== 0;
      hasVBus = (flags & 0x02) !== 0;
      hasBoot = false;
      hasEnv = (flags & 0x04) !== 0;
      hasLux = (flags & 0x08) !== 0;
    } else {
      hasVBat = (flags & 0x01) !== 0;
      hasVBus = (flags & 0x02) !== 0;
      hasBoot = (flags & 0x04) !== 0;
      hasEnv = (flags & 0x08) !== 0;
      hasLux = (flags & 0x10) !== 0;
    }

    if (hasVBat) {
      // Battery: signed int16, LSB = 1/4096 V. Already volts -> `battery`.
      data.battery = round(i16(bytes, i) / 4096.0, 3);
      i += 2;
    }

    if (hasVBus) {
      // Bus/USB supply voltage: signed int16, 1/4096 V. Vendor extra.
      data.vBus = round(i16(bytes, i) / 4096.0, 3);
      i += 2;
    }

    if (hasBoot) {
      // Boot/reset counter: vendor diagnostic extra.
      data.boot = bytes[i];
      i += 1;
    }

    if (hasEnv) {
      // Temperature (int16, 1/256 degC), pressure (u16, LSB = 4 Pa -> hPa),
      // relative humidity (u8 as fraction of 256 -> %).
      air.temperature = round(i16(bytes, i) / 256, 2);
      i += 2;
      air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
      i += 2;
      air.relativeHumidity = round((bytes[i] / 256) * 100, 1);
      i += 1;
    }

    if (hasLux) {
      // Ambient light: u16 lux count.
      air.lightIntensity = u16(bytes, i);
      i += 2;
    }
  } else if (port === 2 || port === 3) {
    // Discriminator-less simple-sensor records. No format byte; the payload
    // starts with the flag bitmap.
    i = 0;
    flags = bytes[i];
    i += 1;

    if (flags & 0x01) {
      data.battery = round(i16(bytes, i) / 4096.0, 3);
      i += 2;
    }

    if (flags & 0x02) {
      // System supply voltage (VDD): signed int16, 1/4096 V. Vendor extra.
      data.vdd = round(i16(bytes, i) / 4096.0, 3);
      i += 2;
    }

    if (flags & 0x04) {
      data.boot = bytes[i];
      i += 1;
    }

    if (flags & 0x08) {
      if (port === 2) {
        // temp (int16/256), pressure (u16 * 4 Pa), RH (u8 / 256).
        air.temperature = round(i16(bytes, i) / 256, 2);
        i += 2;
        air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 1);
        i += 1;
      } else {
        // port 3: temp (int16/256), RH as u16 fraction of 65535. No pressure.
        air.temperature = round(i16(bytes, i) / 256, 2);
        i += 2;
        air.relativeHumidity = round((u16(bytes, i) / 65535) * 100, 1);
        i += 2;
      }
    }

    if (flags & 0x10) {
      // IR / White / UV irradiance counts (calibration-constant * W/m^2). No
      // lux value in this record, so this is not air.lightIntensity; emit the
      // raw channel counts as a vendor extra.
      data.irradiance = {
        ir: u16(bytes, i),
        white: u16(bytes, i + 2),
        uv: u16(bytes, i + 4)
      };
      i += 6;
    }

    if (flags & 0x20) {
      data.vBus = round(i16(bytes, i) / 4096.0, 3);
      i += 2;
    }
  } else {
    return { errors: ['unsupported fPort ' + port] };
  }

  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
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
