// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the MCCI Catena 4802 Modbus/Sensor Node
// (BME280-class air temperature + relative humidity + barometric pressure,
// ambient light/lux, optional air-quality index, plus battery and secondary
// supply rails). The 4802 is a Modbus gateway node, but its environmental
// telemetry rides the standard MCCI Catena flag-bitmap records.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCCI Catena generic flag-bitmap records: port 1 formats 0x11 / 0x14 /
// 0x15 / 0x16 / 0x17, plus the discriminator-less port 2 and port 3 layouts)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena-generic.js,
// attributed in NOTICE; this is the codec the TTN catalog maps the 4802 to for
// firmware v0.5.0+). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Mapping notes:
//   tempC -> air.temperature (degC; signed 16-bit count, LSB = 1/256 degC)
//   rh    -> air.relativeHumidity (%; port 1/2 use an 8-bit fraction of 256,
//            port 3 uses a 16-bit fraction of 65535 -- both -> percent)
//   p     -> air.pressure (hPa; unsigned 16-bit, LSB = 4 Pa -> hPa). ATMOSPHERIC
//            ONLY: the barometer reports station pressure, so the value is mapped
//            to air.pressure only when it falls in the vocabulary's atmospheric
//            band (900-1100 hPa); otherwise it is dropped as out-of-range.
//   lux   -> air.lightIntensity (lux; unsigned 16-bit count, numeric only)
//   iaq   -> air.co2 (ppm; format 0x17 air-quality index scaled to ppm-equiv)
//   vBat  -> battery (V; signed 16-bit count, LSB = 1/4096 V). The device already
//            reports volts, so it maps straight to the vocabulary battery (V) with
//            no percent issue.
// The secondary rails (vBus on port 1, VDD/system rail on ports 2/3 -- both
// reported here as the camelCase extra vBus) and the boot/reset counter are
// genuine device diagnostics with no vocabulary home, emitted as camelCase
// extras (vBus, boot). Derived upstream values (dew point tDewC, the constant
// error:"none" string, water-level estimates, soil channels, energy/pulse
// counters) are not air-climate measurements for this device and are dropped.

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

// UFLT16: 4-bit exponent, 12-bit mantissa (mantissa is a fraction of 4096).
function uflt16(raw) {
  var exp = raw >> 12;
  var mant = (raw & 0xfff) / 4096.0;
  return mant * Math.pow(2, exp - 15);
}

function need(bytes, i, n) {
  return bytes.length - i >= n;
}

// Map a raw barometric reading (hPa) into air.pressure only when atmospheric.
function setPressure(air, hPa) {
  if (hPa >= 900 && hPa <= 1100) {
    air.pressure = hPa;
  }
}

function emit(data, air, hasField) {
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
  if (!hasField) {
    return { errors: ['no sensor fields present in payload'] };
  }
  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  if (port !== 1 && port !== 2 && port !== 3) {
    return { errors: ['unsupported fPort ' + port] };
  }

  var data = {};
  var air = {};
  var i;
  var flags;
  var hasField = false;

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
      return { errors: ['payload too short for format + flag byte'] };
    }

    i = 1;
    flags = bytes[i];
    i += 1;

    // Battery rail (signed 16-bit count, LSB = 1/4096 V). Already volts.
    if (flags & 0x01) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading battery'] };
      }
      data.battery = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }

    // Format 0x11 (Catena 4410) has no boot field; its bitmap is shifted by one
    // relative to the other port-1 formats.
    if (format === 0x11) {
      // bit 0x02: bus/secondary rail (vBus). Diagnostic extra.
      if (flags & 0x02) {
        if (!need(bytes, i, 2)) {
          return { errors: ['payload truncated reading vBus'] };
        }
        data.vBus = round(i16(bytes, i) / 4096.0, 4);
        i += 2;
        hasField = true;
      }
      // bit 0x04: temp / pressure / RH.
      if (flags & 0x04) {
        if (!need(bytes, i, 5)) {
          return { errors: ['payload truncated reading environment block'] };
        }
        air.temperature = round(i16(bytes, i) / 256, 4);
        i += 2;
        setPressure(air, round((u16(bytes, i) * 4) / 100.0, 2));
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 5);
        i += 1;
        hasField = true;
      }
      // bit 0x08: lux.
      if (flags & 0x08) {
        if (!need(bytes, i, 2)) {
          return { errors: ['payload truncated reading lux'] };
        }
        air.lightIntensity = u16(bytes, i);
        i += 2;
        hasField = true;
      }
    } else {
      // Formats 0x14 / 0x15 / 0x16 / 0x17 share the leading bitmap layout.
      // bit 0x02: bus/secondary rail (vBus). Diagnostic extra.
      if (flags & 0x02) {
        if (!need(bytes, i, 2)) {
          return { errors: ['payload truncated reading vBus'] };
        }
        data.vBus = round(i16(bytes, i) / 4096.0, 4);
        i += 2;
        hasField = true;
      }
      // bit 0x04: boot/reset counter. Diagnostic extra.
      if (flags & 0x04) {
        if (!need(bytes, i, 1)) {
          return { errors: ['payload truncated reading boot'] };
        }
        data.boot = bytes[i];
        i += 1;
        hasField = true;
      }
      // bit 0x08: temp / pressure / RH.
      if (flags & 0x08) {
        if (!need(bytes, i, 5)) {
          return { errors: ['payload truncated reading environment block'] };
        }
        air.temperature = round(i16(bytes, i) / 256, 4);
        i += 2;
        setPressure(air, round((u16(bytes, i) * 4) / 100.0, 2));
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 5);
        i += 1;
        hasField = true;
      }
      // bit 0x10: lux.
      if (flags & 0x10) {
        if (!need(bytes, i, 2)) {
          return { errors: ['payload truncated reading lux'] };
        }
        air.lightIntensity = u16(bytes, i);
        i += 2;
        hasField = true;
      }
      // Format 0x17 (AQI): bit 0x20 carries an air-quality index that the
      // upstream codec scales to a ppm-equivalent. Map to air.co2.
      if (format === 0x17 && flags & 0x20) {
        if (!need(bytes, i, 2)) {
          return { errors: ['payload truncated reading air-quality index'] };
        }
        air.co2 = round(uflt16(u16(bytes, i)) * 512, 4);
        i += 2;
        hasField = true;
      }
    }
  } else {
    // Ports 2 and 3: discriminator-less, bitmap is the first byte.
    i = 0;
    flags = bytes[i];
    i += 1;

    // bit 0x01: battery rail (signed 16-bit, LSB = 1/4096 V).
    if (flags & 0x01) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading battery'] };
      }
      data.battery = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }

    // bit 0x02: VDD secondary/system rail (diagnostic extra).
    if (flags & 0x02) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading vBus'] };
      }
      data.vBus = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }

    // bit 0x04: boot/reset counter (diagnostic extra).
    if (flags & 0x04) {
      if (!need(bytes, i, 1)) {
        return { errors: ['payload truncated reading boot'] };
      }
      data.boot = bytes[i];
      i += 1;
      hasField = true;
    }

    // bit 0x08: temp / RH. Port 2 also carries pressure; port 3 does not and
    // uses a 16-bit humidity field.
    if (flags & 0x08) {
      if (port === 2) {
        if (!need(bytes, i, 5)) {
          return { errors: ['payload truncated reading environment block'] };
        }
        air.temperature = round(i16(bytes, i) / 256, 4);
        i += 2;
        setPressure(air, round((u16(bytes, i) * 4) / 100.0, 2));
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 5);
        i += 1;
      } else {
        if (!need(bytes, i, 4)) {
          return { errors: ['payload truncated reading environment block'] };
        }
        air.temperature = round(i16(bytes, i) / 256, 4);
        i += 2;
        air.relativeHumidity = round((u16(bytes, i) / 65535) * 100, 5);
        i += 2;
      }
      hasField = true;
    }

    // bit 0x10: IR / White / UV irradiance raw counts (vendor extra). These are
    // uncalibrated counts, not lux, so they are emitted as a raw diagnostic
    // extra rather than forced into air.lightIntensity.
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
      hasField = true;
    }

    // bit 0x20: bus/secondary rail (diagnostic extra).
    if (flags & 0x20) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading vBus'] };
      }
      data.vBus = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }
  }

  return emit(data, air, hasField);
}
