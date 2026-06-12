// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the MCCI Catena 4470 (and the closely related
// Catena 4410/4450/4460/4551 soil/water/power applications it shares a wire
// format with).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (port 1 record formats 0x11/0x14/0x15/0x16/0x17 with a leading format
// discriminator and a flag bitmap, plus the discriminator-less port 2/3 simple
// formats) was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena-generic.js,
// attributed in NOTICE); the normalization below is authored for this module,
// not copied.
//
// Mapping notes:
//   tempC             -> air.temperature        (degC)
//   rh                -> air.relativeHumidity    (%)
//   p (4 Pa LSB)      -> air.pressure            (hPa)
//   lux               -> air.lightIntensity      (lux, numeric only)
//   tSoil             -> soil.temperature        (degC)
//   rhSoil            -> soil.moisture           (%, soil RH reported as moisture)
//   vBat (int16/4096) -> battery                 (V; device reports volts directly)
// Derived/diagnostic upstream values are NOT measurements: dew points
// (tDewC/tSoilDew) and the constant "error":"none" string are dropped. Genuine
// device data with no vocabulary home is emitted as camelCase extras: vBus, vdd,
// boot counter, one-wire water temperature (tWater), water level/pressure, raw
// power/pulse counters, air-quality (iaq, gas resistance) and raw irradiance
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

// Shared accumulator. air/soil are merged into the result only if non-empty.
function makeState() {
  return { data: {}, air: {}, soil: {}, recognized: false };
}

function setBattery(st, bytes, i) {
  // int16, LSB = 1/4096 V. Already volts -> `battery`.
  st.data.battery = round(i16(bytes, i) / 4096.0, 3);
}

function setTempPressRh(st, bytes, i, havePressure) {
  // temp (int16, /256 degC), optional pressure (u16, 4 Pa LSB -> hPa),
  // humidity (u8, /256 * 100 %).
  st.air.temperature = round(i16(bytes, i) / 256, 4);
  var j = i + 2;
  if (havePressure) {
    st.air.pressure = round((u16(bytes, j) * 4) / 100.0, 2);
    j += 2;
  }
  st.air.relativeHumidity = round((bytes[j] / 256) * 100, 4);
}

function setTempRhU2(st, bytes, i) {
  // port 3: temp (int16, /256 degC) then humidity as u16 (/65535 * 100 %).
  st.air.temperature = round(i16(bytes, i) / 256, 4);
  st.air.relativeHumidity = round((u16(bytes, i + 2) / 65535) * 100, 4);
}

function setSoil(st, bytes, i) {
  // soil temp (int16, /256 degC) then soil RH (u8, /256 * 100 %).
  st.soil.temperature = round(i16(bytes, i) / 256, 4);
  st.soil.moisture = round((bytes[i + 2] / 256) * 100, 4);
}

// ---- port 1: record formats with a leading discriminator byte ----------------

function decodePort1(bytes) {
  var st = makeState();
  var cmd = bytes[0];
  var i = 1;
  var flags = bytes[i];
  i += 1;

  if (cmd === 0x14 || cmd === 0x15 || cmd === 0x16 || cmd === 0x17) {
    // vBat / vBus / boot / temp+press+rh share the low nibble across these.
    if (flags & 0x01) {
      setBattery(st, bytes, i);
      i += 2;
      st.recognized = true;
    }
    if (flags & 0x02) {
      st.data.vBus = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      st.recognized = true;
    }
    if (flags & 0x04) {
      st.data.boot = bytes[i];
      i += 1;
      st.recognized = true;
    }
    if (flags & 0x08) {
      setTempPressRh(st, bytes, i, true);
      i += 5;
      st.recognized = true;
    }
    if (flags & 0x10) {
      st.air.lightIntensity = u16(bytes, i);
      i += 2;
      st.recognized = true;
    }

    if (cmd === 0x14) {
      // 0x20: watt-hour counters; 0x40: floating pulses-per-hour. Raw extras.
      if (flags & 0x20) {
        st.data.powerUsedCount = u16(bytes, i);
        st.data.powerSourcedCount = u16(bytes, i + 2);
        i += 4;
      }
      if (flags & 0x40) {
        st.data.powerUsedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 4);
        st.data.powerSourcedPerHour = round(uflt16(u16(bytes, i + 2)) * 60 * 60 * 4, 4);
        i += 4;
      }
    } else if (cmd === 0x15) {
      // 0x20: one-wire (water) temperature; 0x40: soil temp + soil RH.
      if (flags & 0x20) {
        st.data.tWater = round(i16(bytes, i) / 256, 4);
        i += 2;
      }
      if (flags & 0x40) {
        setSoil(st, bytes, i);
        i += 3;
      }
    } else if (cmd === 0x16) {
      // 0x20: Rayco water-pressure/level sensor. Raw extras.
      if (flags & 0x20) {
        var wp = ((u16(bytes, i) * 4) / 100.0) / 10;
        st.data.waterPressure = round(wp, 4);
        st.data.waterLevel = round((wp * 1000) / (1000 * 9.81), 4);
        i += 2;
      }
    } else if (cmd === 0x17) {
      // 0x20: IAQ index; 0x40: gas resistance; 0x80: IAQ quality flags.
      if (flags & 0x20) {
        st.data.iaq = round(uflt16(u16(bytes, i)) * 512, 4);
        i += 2;
      }
      if (flags & 0x40) {
        var logGasR = uflt16(u16(bytes, i)) * 16;
        st.data.logRGas = round(logGasR, 4);
        st.data.rGas = round(Math.pow(10, logGasR), 4);
        i += 2;
      }
      if (flags & 0x80) {
        st.data.iaqQuality = bytes[i] & 3;
        i += 1;
      }
    }
  } else if (cmd === 0x11) {
    // Catena 4410: vBat, vBus, temp+press+rh, lux, water temp, soil temp+RH.
    if (flags & 0x01) {
      setBattery(st, bytes, i);
      i += 2;
      st.recognized = true;
    }
    if (flags & 0x02) {
      st.data.vBus = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      st.recognized = true;
    }
    if (flags & 0x04) {
      setTempPressRh(st, bytes, i, true);
      i += 5;
      st.recognized = true;
    }
    if (flags & 0x08) {
      st.air.lightIntensity = u16(bytes, i);
      i += 2;
      st.recognized = true;
    }
    if (flags & 0x10) {
      st.data.tWater = round(i16(bytes, i) / 256, 4);
      i += 2;
      st.recognized = true;
    }
    if (flags & 0x20) {
      setSoil(st, bytes, i);
      i += 3;
      st.recognized = true;
    }
  } else {
    return { errors: ['unsupported port 1 record format 0x' + cmd.toString(16)] };
  }

  return finalize(st);
}

// ---- ports 2/3: discriminator-less simple formats ---------------------------

function decodePort2(bytes) {
  var st = makeState();
  var i = 0;
  var flags = bytes[i];
  i += 1;

  if (flags & 0x01) {
    setBattery(st, bytes, i);
    i += 2;
    st.recognized = true;
  }
  if (flags & 0x02) {
    st.data.vdd = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    st.recognized = true;
  }
  if (flags & 0x04) {
    st.data.boot = bytes[i];
    i += 1;
    st.recognized = true;
  }
  if (flags & 0x08) {
    setTempPressRh(st, bytes, i, true);
    i += 5;
    st.recognized = true;
  }
  if (flags & 0x10) {
    // IR/White/UV irradiance counts (calibration-constant scaled). Raw extras.
    st.data.irradiance = { ir: u16(bytes, i), white: u16(bytes, i + 2), uv: u16(bytes, i + 4) };
    i += 6;
    st.recognized = true;
  }
  if (flags & 0x20) {
    st.data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    st.recognized = true;
  }

  return finalize(st);
}

function decodePort3(bytes) {
  var st = makeState();
  var i = 0;
  var flags = bytes[i];
  i += 1;

  if (flags & 0x01) {
    setBattery(st, bytes, i);
    i += 2;
    st.recognized = true;
  }
  if (flags & 0x02) {
    st.data.vdd = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    st.recognized = true;
  }
  if (flags & 0x04) {
    st.data.boot = bytes[i];
    i += 1;
    st.recognized = true;
  }
  if (flags & 0x08) {
    setTempRhU2(st, bytes, i);
    i += 4;
    st.recognized = true;
  }
  if (flags & 0x10) {
    st.data.irradiance = { ir: u16(bytes, i), white: u16(bytes, i + 2), uv: u16(bytes, i + 4) };
    i += 6;
    st.recognized = true;
  }
  if (flags & 0x20) {
    st.data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    st.recognized = true;
  }

  return finalize(st);
}

function finalize(st) {
  if (!st.recognized) {
    return { errors: ['no recognized sensor fields in payload'] };
  }
  var k;
  var hasAir = false;
  for (k in st.air) {
    if (st.air.hasOwnProperty(k)) {
      hasAir = true;
    }
  }
  if (hasAir) {
    st.data.air = st.air;
  }
  var hasSoil = false;
  for (k in st.soil) {
    if (st.soil.hasOwnProperty(k)) {
      hasSoil = true;
    }
  }
  if (hasSoil) {
    st.data.soil = st.soil;
  }
  return { data: st.data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  if (port === 1) {
    if (bytes.length < 2) {
      return { errors: ['port 1 payload too short for format + flags'] };
    }
    return decodePort1(bytes);
  }
  if (port === 2) {
    return decodePort2(bytes);
  }
  if (port === 3) {
    return decodePort3(bytes);
  }
  return { errors: ['unsupported fPort ' + port] };
}
