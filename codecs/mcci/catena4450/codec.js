// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena 4450 (a Catena 441x/445x/446x-class
// soil/water/power/air-quality node: temperature, relative humidity, barometric
// pressure, ambient lux, battery, optional bus voltage, optional CO2/AQI, and
// optional power/pulse counters).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (port 1 discriminated formats 0x11/0x14/0x15/0x16/0x17 and the
// discriminator-less port 2 / port 3 formats, each a flag bitmap of fields)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena-generic.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Mapping notes:
//   tempC -> air.temperature (degC), rh -> air.relativeHumidity (%),
//   p -> air.pressure (hPa), lux -> air.lightIntensity (lux, numeric only),
//   aqi/iaq -> air.co2 (ppm-equivalent index), vBat -> battery (V; the device
//   already reports volts via int16/4096, so there is no percent issue).
// Upstream's derived dew points (tDewC/tSoilDew), the synthetic "error":"none"
// marker, and water-level pressure->head computations are NOT measurements and
// are dropped. Genuine device data with no vocabulary home is emitted as
// camelCase extras: bus voltage (vBus / vdd), boot counter, soil/water probe
// temperatures and RH, water pressure, power/pulse counters, and raw irradiance
// channels.

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

function hasKeys(obj) {
  var k;
  for (k in obj) {
    if (obj.hasOwnProperty(k)) {
      return true;
    }
  }
  return false;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 1 && port !== 2 && port !== 3) {
    return { errors: ['unsupported fPort ' + port] };
  }
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var i = 0;
  var format = 0;

  if (port === 1) {
    format = bytes[0];
    if (
      format !== 0x11 &&
      format !== 0x14 &&
      format !== 0x15 &&
      format !== 0x16 &&
      format !== 0x17
    ) {
      return { errors: ['unsupported uplink format 0x' + format.toString(16)] };
    }
    i = 1;
  }

  if (bytes.length < i + 1) {
    return { errors: ['payload too short for flag byte'] };
  }
  var flags = bytes[i++];

  // The flag layout differs between the discriminated 0x11 format and the rest.
  // 0x11 has no boot byte and no vBus, so its temp/lux/probe bits shift down by
  // one position relative to 0x14/0x15/0x16/0x17 and ports 2/3.
  var is11 = port === 1 && format === 0x11;

  // --- vBat (battery, volts) -------------------------------------------------
  if (flags & 0x1) {
    data.battery = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  // --- vBus / VDD (bus or system voltage; vocabulary has no home -> extra) ----
  // Present at bit 0x2 on every layout EXCEPT 0x11 (which uses 0x2 for env).
  if (!is11 && flags & 0x2) {
    data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
  }

  // --- boot counter (extra) --------------------------------------------------
  // Port 1 formats 0x14/0x15/0x16/0x17 and ports 2/3 carry boot at bit 0x4.
  if (!is11 && flags & 0x4) {
    data.boot = bytes[i];
    i += 1;
  }

  if (is11) {
    // -- 0x11: bit 0x2 = temp/p/rh, 0x4 = lux, 0x10 = water temp,
    //          0x20 = soil temp+RH (no boot, no vBus). --
    if (flags & 0x2) {
      air.temperature = round(i16(bytes, i) / 256, 2);
      i += 2;
      air.pressure = round((u16(bytes, i) * 4) / 100.0, 1);
      i += 2;
      air.relativeHumidity = round((bytes[i] / 256) * 100, 1);
      i += 1;
    }
    if (flags & 0x4) {
      air.lightIntensity = u16(bytes, i);
      i += 2;
    }
    if (flags & 0x10) {
      data.waterTemperature = round(i16(bytes, i) / 256, 2);
      i += 2;
    }
    if (flags & 0x20) {
      data.soilTemperature = round(i16(bytes, i) / 256, 2);
      i += 2;
      data.soilRelativeHumidity = round((bytes[i] / 256) * 100, 1);
      i += 1;
    }
  } else {
    // -- env: temp/pressure/RH at bit 0x8 on 0x14/0x15/0x16/0x17 and port 2.
    //    Port 3 has the same bit but RH is a u16 fraction with no pressure. --
    if (flags & 0x8) {
      air.temperature = round(i16(bytes, i) / 256, 2);
      i += 2;
      if (port === 3) {
        air.relativeHumidity = round((u16(bytes, i) / 65535) * 100, 1);
        i += 2;
      } else {
        air.pressure = round((u16(bytes, i) * 4) / 100.0, 1);
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 1);
        i += 1;
      }
    }

    if (port === 1) {
      // -- lux at bit 0x10 for all port-1 formats other than 0x11. --
      if (flags & 0x10) {
        air.lightIntensity = u16(bytes, i);
        i += 2;
      }

      if (format === 0x14) {
        // 0x20 = power (watt-hour) counters; 0x40 = power-per-hour floats.
        if (flags & 0x20) {
          data.powerUsedCount = u16(bytes, i);
          i += 2;
          data.powerSourcedCount = u16(bytes, i);
          i += 2;
        }
        if (flags & 0x40) {
          data.powerUsedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 3);
          i += 2;
          data.powerSourcedPerHour = round(
            uflt16(u16(bytes, i)) * 60 * 60 * 4,
            3
          );
          i += 2;
        }
      } else if (format === 0x15) {
        // 0x20 = one-wire water temp; 0x40 = soil temp followed by soil RH.
        if (flags & 0x20) {
          data.waterTemperature = round(i16(bytes, i) / 256, 2);
          i += 2;
        }
        if (flags & 0x40) {
          data.soilTemperature = round(i16(bytes, i) / 256, 2);
          i += 2;
          data.soilRelativeHumidity = round((bytes[i] / 256) * 100, 1);
          i += 1;
        }
      } else if (format === 0x16) {
        // 0x20 = water-pressure (hPa on the wire). Keep pressure as an extra;
        // upstream's head-of-water computation is derived and is dropped.
        if (flags & 0x20) {
          data.waterPressure = round((u16(bytes, i) * 4) / 100.0, 2);
          i += 2;
        }
      } else if (format === 0x17) {
        // 0x20 = IAQ index (UFLT16 * 512) -> air.co2 (ppm-equivalent index);
        // 0x40 = gas resistance log (extra); 0x80 = IAQ quality flags (extra).
        if (flags & 0x20) {
          air.co2 = round(uflt16(u16(bytes, i)) * 512, 0);
          i += 2;
        }
        if (flags & 0x40) {
          var logGasR = uflt16(u16(bytes, i)) * 16;
          i += 2;
          data.logGasResistance = round(logGasR, 4);
          data.gasResistance = round(Math.pow(10, logGasR), 0);
        }
        if (flags & 0x80) {
          data.iaqQuality = bytes[i] & 0x3;
          i += 1;
        }
      }
    } else {
      // -- ports 2 & 3: bit 0x10 = IR/White/UV irradiance triple (raw extra);
      //    bit 0x20 = vBus. --
      if (flags & 0x10) {
        data.irradiance = {
          ir: u16(bytes, i),
          white: u16(bytes, i + 2),
          uv: u16(bytes, i + 4)
        };
        i += 6;
      }
      if (flags & 0x20) {
        data.vBus = round(i16(bytes, i) / 4096.0, 4);
        i += 2;
      }
    }
  }

  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }

  if (hasKeys(air)) {
    data.air = air;
  }

  return { data: data };
}
