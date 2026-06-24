// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena Model 4832 (High-Accuracy Outdoor
// Environmental Sensor, SHT35: air temperature/humidity, barometric pressure
// and ambient light; battery voltage).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (the generic MCCI Catena message family — a one-byte format
// discriminator on fPort 1, or a bare flag bitmap on fPort 2/3) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcci/codec-catena-generic.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping notes:
//   tempC -> air.temperature (degC), rh -> air.relativeHumidity (%),
//   p -> air.pressure (hPa; raw is already hPa), lux -> air.lightIntensity
//   (lux, numeric only), soil temp/RH -> soil.temperature / soil.moisture,
//   one-wire water temp -> water.temperature.current,
//   vBat -> battery (V; MCCI reports a signed int16 in 1/4096 V, i.e. already
//   volts, so there is no percent-vs-volts issue).
// Derived upstream values (dew points, water level from pressure) are NOT
// measurements and are dropped. Genuine device data with no vocabulary home is
// emitted as camelCase extras: boot/reset counter, secondary bus/system rails
// (vBus, vdd), raw irradiance counts (IR/White/UV), pulse/power counters and
// air-quality diagnostics (iaq, logRGas, rGas, iaqQuality).

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

function hasOwn(obj) {
  var k;
  for (k in obj) {
    if (obj.hasOwnProperty(k)) {
      return true;
    }
  }
  return false;
}

// Decode the fPort-1 generic Catena record. `start` is the index of the flag
// bitmap (the byte after the one-byte format discriminator). `withPressure`
// selects whether the temp/RH block also carries barometric pressure; `format`
// selects which trailing flags are present (the 0x11 stream omits the boot
// counter and shifts the later flag bits down by one).
function decodePort1(bytes, format, out, air, soil, water) {
  var i = 1;
  var flags = bytes[i];
  i += 1;

  if (format === 0x11) {
    // Catena 4410: vBat, vBus, {temp,p,rh}, lux, water temp, {soil temp,rh}.
    if (flags & 0x01) {
      out.battery = round(i16(bytes, i) / 4096.0, 3);
      i += 2;
    }
    if (flags & 0x02) {
      out.vBus = round(i16(bytes, i) / 4096.0, 3);
      i += 2;
    }
    if (flags & 0x04) {
      air.temperature = round(i16(bytes, i) / 256, 2);
      i += 2;
      air.pressure = round((u16(bytes, i) * 4) / 100.0, 1);
      i += 2;
      air.relativeHumidity = round((bytes[i] / 256) * 100, 1);
      i += 1;
    }
    if (flags & 0x08) {
      air.lightIntensity = u16(bytes, i);
      i += 2;
    }
    if (flags & 0x10) {
      water.temperature = { current: round(i16(bytes, i) / 256, 2) };
      i += 2;
    }
    if (flags & 0x20) {
      soil.temperature = round(i16(bytes, i) / 256, 2);
      i += 2;
      soil.moisture = round((bytes[i] / 256) * 100, 1);
      i += 1;
    }
    return true;
  }

  // Formats 0x14 / 0x15 / 0x16 / 0x17 share the leading flags 0x01..0x10.
  if (flags & 0x01) {
    out.battery = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }
  if (flags & 0x02) {
    out.vBus = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }
  if (flags & 0x04) {
    out.boot = bytes[i];
    i += 1;
  }
  if (flags & 0x08) {
    air.temperature = round(i16(bytes, i) / 256, 2);
    i += 2;
    air.pressure = round((u16(bytes, i) * 4) / 100.0, 1);
    i += 2;
    air.relativeHumidity = round((bytes[i] / 256) * 100, 1);
    i += 1;
  }
  if (flags & 0x10) {
    air.lightIntensity = u16(bytes, i);
    i += 2;
  }

  if (format === 0x14) {
    // Power application: raw watt-hour / pulse-per-hour counters.
    if (flags & 0x20) {
      out.powerUsedCount = u16(bytes, i);
      i += 2;
      out.powerSourcedCount = u16(bytes, i);
      i += 2;
    }
    if (flags & 0x40) {
      out.powerUsedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 3);
      i += 2;
      out.powerSourcedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 3);
      i += 2;
    }
  } else if (format === 0x15) {
    // Soil/water application: one-wire water temp, then soil temp + RH.
    if (flags & 0x20) {
      water.temperature = { current: round(i16(bytes, i) / 256, 2) };
      i += 2;
    }
    if (flags & 0x40) {
      soil.temperature = round(i16(bytes, i) / 256, 2);
      i += 2;
      soil.moisture = round((bytes[i] / 256) * 100, 1);
      i += 1;
    }
  } else if (format === 0x16) {
    // Water-level application: raw differential pressure (kept as an extra; the
    // derived water level is a computed value, not a measurement, so dropped).
    if (flags & 0x20) {
      out.waterPressureKpa = round((u16(bytes, i) * 4) / 100.0 / 10, 4);
      i += 2;
    }
  } else if (format === 0x17) {
    // Air-quality application: indoor air-quality index and gas-resistance
    // diagnostics. No vocabulary home -> camelCase extras.
    if (flags & 0x20) {
      out.iaq = round(uflt16(u16(bytes, i)) * 512, 4);
      i += 2;
    }
    if (flags & 0x40) {
      var logRGas = uflt16(u16(bytes, i)) * 16;
      i += 2;
      out.logRGas = round(logRGas, 4);
      out.rGas = round(Math.pow(10, logRGas), 4);
    }
    if (flags & 0x80) {
      out.iaqQuality = bytes[i] & 3;
      i += 1;
    }
  }
  return true;
}

// fPort 2/3 simple-sensor stream: a bare flag bitmap, no format discriminator.
// Port 3 carries no barometric pressure and reports RH as a u16.
function decodeSimple(bytes, withPressure, out, air) {
  var i = 0;
  var flags = bytes[i];
  i += 1;

  if (flags & 0x01) {
    out.battery = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }
  if (flags & 0x02) {
    out.vdd = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }
  if (flags & 0x04) {
    out.boot = bytes[i];
    i += 1;
  }
  if (flags & 0x08) {
    air.temperature = round(i16(bytes, i) / 256, 2);
    i += 2;
    if (withPressure) {
      air.pressure = round((u16(bytes, i) * 4) / 100.0, 1);
      i += 2;
      air.relativeHumidity = round((bytes[i] / 256) * 100, 1);
      i += 1;
    } else {
      air.relativeHumidity = round((u16(bytes, i) / 65535) * 100, 1);
      i += 2;
    }
  }
  if (flags & 0x10) {
    // IR / White / UV irradiance: raw calibrated counts (C * W/m^2), not lux.
    out.irradiance = {
      ir: u16(bytes, i),
      white: u16(bytes, i + 2),
      uv: u16(bytes, i + 4)
    };
    i += 6;
  }
  if (flags & 0x20) {
    out.vBus = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }
  return true;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 1 && port !== 2 && port !== 3) {
    return { errors: ['unsupported fPort ' + port] };
  }
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var out = {};
  var air = {};
  var soil = {};
  var water = {};

  if (port === 1) {
    if (bytes.length < 2) {
      return { errors: ['payload too short for fPort 1 header'] };
    }
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
    decodePort1(bytes, format, out, air, soil, water);
  } else if (port === 2) {
    decodeSimple(bytes, true, out, air);
  } else {
    decodeSimple(bytes, false, out, air);
  }

  if (hasOwn(air)) {
    out.air = air;
  }
  if (hasOwn(soil)) {
    out.soil = soil;
  }
  if (hasOwn(water)) {
    out.water = water;
  }

  if (!hasOwn(out)) {
    return { errors: ['no sensor fields present in payload'] };
  }

  return { data: out };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcci";
    result.data.model = "model4832";
  }
  return result;
}
