// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Catena Model 4831 Outdoor Environmental
// Sensor (SHT31: air temperature + relative humidity, ambient light/lux,
// optional barometric pressure and air-quality CO2; battery voltage).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCCI Catena generic flag-bitmap records: port 1 formats 0x11 / 0x14 /
// 0x15 / 0x16 / 0x17, plus the discriminator-less port 2 and port 3 layouts)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-catena-generic.js,
// attributed in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Mapping notes:
//   tempC -> air.temperature (degC), rh -> air.relativeHumidity (%),
//   p -> air.pressure (hPa), lux -> air.lightIntensity (lux, numeric),
//   iaq/co2 -> air.co2 (ppm).
//   vBat is a signed 16-bit count, LSB = 1/4096 V; the device already reports
//   volts, so it maps straight to the vocabulary `battery` (V) with no percent
//   issue. The secondary rail (vBus / VDD) and the boot counter are genuine
//   device diagnostics with no vocabulary home, emitted as camelCase extras
//   (vBus, boot). Derived upstream values (dew point tDewC, the constant
//   error:"none" string, water-level estimates, soil channels, energy/pulse
//   counters) are not air-climate/light measurements for this device and are
//   dropped from the normalized output.

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

    i = 1;
    flags = bytes[i];
    i += 1;

    // Battery rail (signed 16-bit count, LSB = 1/4096 V). Already volts.
    if (flags & 0x01) {
      data.battery = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }

    // Format 0x11 has no boot field; its bitmap is shifted by one relative to
    // the other port-1 formats.
    if (format === 0x11) {
      // bit 0x02: bus/secondary rail (vBus). Diagnostic extra.
      if (flags & 0x02) {
        data.vBus = round(i16(bytes, i) / 4096.0, 4);
        i += 2;
        hasField = true;
      }
      // bit 0x04: temp / pressure / RH.
      if (flags & 0x04) {
        air.temperature = round(i16(bytes, i) / 256, 4);
        i += 2;
        air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 5);
        i += 1;
        hasField = true;
      }
      // bit 0x08: lux.
      if (flags & 0x08) {
        air.lightIntensity = u16(bytes, i);
        i += 2;
        hasField = true;
      }
      // bit 0x10: one-wire water temperature (not an air measurement; skip
      // its bytes to keep the stream aligned, but do not emit).
      if (flags & 0x10) {
        i += 2;
      }
      // bit 0x20: soil temp + RH (not an air measurement; skip 3 bytes).
      if (flags & 0x20) {
        i += 3;
      }
    } else {
      // Formats 0x14 / 0x15 / 0x16 / 0x17 share the leading bitmap layout.
      // bit 0x02: bus/secondary rail (vBus). Diagnostic extra.
      if (flags & 0x02) {
        data.vBus = round(i16(bytes, i) / 4096.0, 4);
        i += 2;
        hasField = true;
      }
      // bit 0x04: boot/reset counter. Diagnostic extra.
      if (flags & 0x04) {
        data.boot = bytes[i];
        i += 1;
        hasField = true;
      }
      // bit 0x08: temp / pressure / RH.
      if (flags & 0x08) {
        air.temperature = round(i16(bytes, i) / 256, 4);
        i += 2;
        air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 5);
        i += 1;
        hasField = true;
      }
      // bit 0x10: lux.
      if (flags & 0x10) {
        air.lightIntensity = u16(bytes, i);
        i += 2;
        hasField = true;
      }
      // Format 0x17 (AQI): bit 0x20 carries an air-quality index that the
      // upstream codec scales to ppm-equivalent. Map to air.co2.
      if (format === 0x17 && flags & 0x20) {
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
      data.battery = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }

    // bit 0x02: VDD secondary rail (diagnostic extra).
    if (flags & 0x02) {
      data.vBus = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }

    // bit 0x04: boot/reset counter (diagnostic extra).
    if (flags & 0x04) {
      data.boot = bytes[i];
      i += 1;
      hasField = true;
    }

    // bit 0x08: temp / RH. Port 2 also carries pressure; port 3 does not.
    if (flags & 0x08) {
      air.temperature = round(i16(bytes, i) / 256, 4);
      i += 2;
      if (port === 2) {
        air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
        i += 2;
        air.relativeHumidity = round((bytes[i] / 256) * 100, 5);
        i += 1;
      } else {
        air.relativeHumidity = round((u16(bytes, i) / 65535) * 100, 5);
        i += 2;
      }
      hasField = true;
    }

    // bit 0x10: IR / White / UV irradiance raw counts (vendor extra). The
    // White channel is the closest to ambient illuminance, but it is an
    // uncalibrated count, not lux; emit all three as a raw diagnostic extra
    // rather than forcing into air.lightIntensity.
    if (flags & 0x10) {
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
      data.vBus = round(i16(bytes, i) / 4096.0, 4);
      i += 2;
      hasField = true;
    }
  }

  return emit(data, air, hasField);
}
