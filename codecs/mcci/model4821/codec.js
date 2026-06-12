// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Model 4821 (Indoor Environmental Sensor,
// a BME280-based MCCI Catena 4450/4551-class node: temperature, relative
// humidity, barometric pressure, ambient light, plus battery/boot diagnostics).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (the MCCI Catena generic flag-bitmap formats — port 1 formats
// 0x11/0x14/0x15/0x16/0x17, port 2 and port 3) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcci/codec-catena-generic.js, attributed in NOTICE). Do NOT copy the
// upstream normalizeUplink — the normalization below is authored here.
//
// Mapping notes:
//   tempC -> air.temperature (degC), rh -> air.relativeHumidity (%),
//   p -> air.pressure (hPa), lux -> air.lightIntensity (lux, numeric only),
//   vBat -> battery (V; MCCI reports int16/4096 VOLTS, so no percent issue),
//   tSoil/rhSoil -> soil.temperature / soil.moisture, tWater (1-wire probe) ->
//   water.temperature.current.
// Genuine device data with no vocabulary home is emitted as camelCase extras:
//   boot counter, vBus / vdd rails, raw IR/White/UV irradiance counts, water
//   pressure/level (Rayco), and BME680 air-quality (iaq / gas resistance).
// Derived upstream values (dew points) and the hardcoded "error" string are NOT
// measurements and are dropped.

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

// Decodes one flag-bitmap body starting at `start` into `acc`. The bit order is
// fixed per cmd/port (see upstream); `layout` names the optional-field bits in
// the order they appear so a single loop can serve every Catena format.
function setAir(acc, key, value) {
  if (!acc.air) {
    acc.air = {};
  }
  acc.air[key] = value;
}

function setSoil(acc, key, value) {
  if (!acc.soil) {
    acc.soil = {};
  }
  acc.soil[key] = value;
}

function setWaterTemp(acc, value) {
  if (!acc.water) {
    acc.water = {};
  }
  if (!acc.water.temperature) {
    acc.water.temperature = {};
  }
  acc.water.temperature.current = value;
}

// Field handlers, keyed by a layout token. Each reads from bytes at index `i`
// and returns the new index after consuming its bytes.
function readField(token, bytes, i, acc) {
  if (token === 'vBat') {
    // int16 / 4096 V -> battery (volts), rounded to mV.
    acc.battery = round(i16(bytes, i) / 4096.0, 3);
    return i + 2;
  }
  if (token === 'vBus') {
    acc.vBus = round(i16(bytes, i) / 4096.0, 3);
    return i + 2;
  }
  if (token === 'vdd') {
    acc.vdd = round(i16(bytes, i) / 4096.0, 3);
    return i + 2;
  }
  if (token === 'boot') {
    acc.boot = bytes[i];
    return i + 1;
  }
  if (token === 'thp') {
    // temp (int16/256), pressure (u16 *4 -> Pa -> hPa), RH (u8/256*100).
    setAir(acc, 'temperature', round(i16(bytes, i) / 256, 2));
    setAir(acc, 'pressure', round(u16(bytes, i + 2) * 4 / 100.0, 2));
    setAir(acc, 'relativeHumidity', round((bytes[i + 4] / 256) * 100, 2));
    return i + 5;
  }
  if (token === 'th2') {
    // port 3: temp (int16/256), RH as u16/65535*100.
    setAir(acc, 'temperature', round(i16(bytes, i) / 256, 2));
    setAir(acc, 'relativeHumidity', round((u16(bytes, i + 2) / 65535) * 100, 2));
    return i + 4;
  }
  if (token === 'lux') {
    setAir(acc, 'lightIntensity', u16(bytes, i));
    return i + 2;
  }
  if (token === 'tWater') {
    setWaterTemp(acc, round(i16(bytes, i) / 256, 2));
    return i + 2;
  }
  if (token === 'soilTH') {
    // soil temp (int16/256) then soil RH/moisture (u8/256*100).
    setSoil(acc, 'temperature', round(i16(bytes, i) / 256, 2));
    setSoil(acc, 'moisture', round((bytes[i + 2] / 256) * 100, 2));
    return i + 3;
  }
  if (token === 'power') {
    // watt-hour counters (raw u16 each).
    acc.powerUsedCount = u16(bytes, i);
    acc.powerSourcedCount = u16(bytes, i + 2);
    return i + 4;
  }
  if (token === 'pulses') {
    // pulses-per-hour as two uflt16, scaled (raw device rate).
    acc.powerUsedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 6);
    acc.powerSourcedPerHour = round(uflt16(u16(bytes, i + 2)) * 60 * 60 * 4, 6);
    return i + 4;
  }
  if (token === 'irradiance') {
    // raw IR/White/UV counts (C*W/m2, calibration-dependent — NOT lux).
    acc.irradiance = {
      ir: u16(bytes, i),
      white: u16(bytes, i + 2),
      uv: u16(bytes, i + 4)
    };
    return i + 6;
  }
  if (token === 'wlevel') {
    // Rayco water pressure -> kPa, derived level (m). Raw device extras.
    var wPressure = (u16(bytes, i) * 4 / 100.0) / 10;
    acc.waterPressure = round(wPressure, 6);
    acc.waterLevel = round((wPressure * 1000) / (1000 * 9.81), 6);
    return i + 2;
  }
  if (token === 'iaq') {
    acc.iaq = round(uflt16(u16(bytes, i)) * 512, 6);
    return i + 2;
  }
  if (token === 'gas') {
    var logGasR = uflt16(u16(bytes, i)) * 16;
    acc.logRGas = round(logGasR, 6);
    acc.rGas = round(Math.pow(10, logGasR), 6);
    return i + 2;
  }
  if (token === 'iaqQuality') {
    acc.iaqQuality = bytes[i] & 3;
    return i + 1;
  }
  return i;
}

function decodeBitmap(bytes, start, layout, acc) {
  var i = start;
  if (i >= bytes.length) {
    return { error: 'missing flag byte' };
  }
  var flags = bytes[i];
  i += 1;
  var bit;
  var n;
  for (n = 0; n < layout.length; n++) {
    bit = 1 << n;
    if (flags & bit) {
      i = readField(layout[n], bytes, i, acc);
    }
  }
  return { flags: flags, end: i };
}

function finalize(acc, flags) {
  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }
  var data = {};
  var k;
  for (k in acc) {
    if (acc.hasOwnProperty(k)) {
      data[k] = acc[k];
    }
  }
  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var acc = {};
  var res;

  if (port === 1) {
    var cmd = bytes[0];
    if (cmd === 0x14 || cmd === 0x15) {
      // Catena 4450 M101 (0x14) / M102 (0x15).
      // bits: vBat, vBus, boot, thp, lux, then per-cmd tail.
      var layout14 =
        cmd === 0x14
          ? ['vBat', 'vBus', 'boot', 'thp', 'lux', 'power', 'pulses']
          : ['vBat', 'vBus', 'boot', 'thp', 'lux', 'tWater', 'soilTH'];
      res = decodeBitmap(bytes, 1, layout14, acc);
    } else if (cmd === 0x11) {
      // Catena 4410: no boot field; soil/water block.
      res = decodeBitmap(
        bytes,
        1,
        ['vBat', 'vBus', 'thp', 'lux', 'tWater', 'soilTH'],
        acc
      );
    } else if (cmd === 0x16) {
      // Catena 4450 water level (Rayco).
      res = decodeBitmap(
        bytes,
        1,
        ['vBat', 'vBus', 'boot', 'thp', 'lux', 'wlevel'],
        acc
      );
    } else if (cmd === 0x17) {
      // Catena 4460 air-quality (BME680).
      res = decodeBitmap(
        bytes,
        1,
        ['vBat', 'vBus', 'boot', 'thp', 'lux', 'iaq', 'gas', 'iaqQuality'],
        acc
      );
    } else {
      return { errors: ['unsupported port 1 format 0x' + cmd.toString(16)] };
    }
  } else if (port === 2) {
    res = decodeBitmap(
      bytes,
      0,
      ['vBat', 'vdd', 'boot', 'thp', 'irradiance', 'vBus'],
      acc
    );
  } else if (port === 3) {
    res = decodeBitmap(
      bytes,
      0,
      ['vBat', 'vdd', 'boot', 'th2', 'irradiance', 'vBus'],
      acc
    );
  } else {
    return { errors: ['unsupported fPort ' + port] };
  }

  if (res.error) {
    return { errors: [res.error] };
  }
  return finalize(acc, res.flags);
}
