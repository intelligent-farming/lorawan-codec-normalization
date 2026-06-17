// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Model 4933 multigas + environment sensor
// (BME280-class air temperature, relative humidity and barometric pressure;
// an electrochemical multigas head reporting CO / NO2 / O3 / SO2; an optional
// laser particulate-matter counter; and battery / bus voltages).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCCI Model 4933 flag-bitmap record: port 1, uplink format 0x38)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcci/codec-model4933.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink / Decoder output.
//
// Wire layout (port 1, format byte 0x38, then bitmap "flags"):
//   flags 0x01 -> Vbat  (int16 count, LSB = 1/4096 V)
//   flags 0x02 -> Vbus  (int16 count, LSB = 1/4096 V)
//   flags 0x04 -> boot  (uint8 reset counter)
//   flags 0x08 -> particulate block: 7x PM mass concentration (UFLT16 * 512,
//                 ug/m3) then 3x particle counts (U32)
//   flags 0x10 -> CO  ppm (UFLT16 * 1000)
//   flags 0x20 -> NO2 ppm (UFLT16 * 10)
//   flags 0x40 -> O3  ppm (UFLT16 * 30)
//   flags 0x80 -> SO2 ppm (UFLT16 * 30)
//   ALWAYS (after the first bitmap, unconditionally): 4x electrode voltages
//                 vCO / vNO2 / vO3 / vSO2 (int16 count, LSB = 1/4096 V)
//   second bitmap "flags2":
//     flags2 0x01 -> temperature (int16, LSB = 1/256 degC) + relative humidity
//                    (uint16, full-scale 65535 = 100%)
//     flags2 0x02 -> barometric pressure (uint16, LSB = 4 Pa -> hPa)
//     flags2 0x04 -> network/boot timestamp (U32; low bit selects time source,
//                    value is (raw >> 1) * 2 + 17 seconds since the Unix epoch)
//
// Mapping notes:
//   t  -> air.temperature (degC).
//   rh -> air.relativeHumidity (%).
//   p  -> air.pressure (hPa). ATMOSPHERIC: the device reports station
//         barometric pressure (LSB = 4 Pa, typical range ~900-1100 hPa), so it
//         maps straight to the vocabulary air.pressure.
//   Vbat -> battery (V). The device already reports volts, so it maps straight
//         to the vocabulary battery (no percent issue).
//   timestamp -> time (RFC3339) at the top level.
// Genuine device data with no vocabulary home is emitted as camelCase extras:
//   vBus (secondary bus rail, V), boot (reset counter), vCO / vNO2 / vO3 / vSO2
//   (gas-electrode rail voltages, V), coPpm / no2Ppm / o3Ppm / so2Ppm (gas
//   concentrations, ppm; the vocabulary only models air.co2, not CO/NO2/O3/SO2),
//   pm (PM mass concentrations, ug/m3), pc (particle counts), and timeType (the
//   timestamp source). Derived upstream values that are not direct measurements
//   (dew point tDew, heat index tHeatIndexC) are dropped from the normalized
//   output.

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

function u32(bytes, i) {
  return (
    (bytes[i] * 0x1000000 +
      ((bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3])) >>>
    0
  );
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

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  if (port !== 1) {
    return { errors: ['unsupported fPort ' + port] };
  }

  var format = bytes[0];
  if (format !== 0x38) {
    return { errors: ['unsupported uplink format 0x' + format.toString(16)] };
  }
  if (bytes.length < 2) {
    return { errors: ['payload too short for format + flag byte'] };
  }

  var data = {};
  var air = {};
  var i = 1;
  var flags = bytes[i];
  i += 1;
  var hasField = false;

  // flags 0x01: battery rail (int16 count, LSB = 1/4096 V). Already volts.
  if (flags & 0x01) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading battery'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    hasField = true;
  }

  // flags 0x02: secondary bus rail (vBus). Diagnostic extra.
  if (flags & 0x02) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading vBus'] };
    }
    data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    hasField = true;
  }

  // flags 0x04: boot/reset counter. Diagnostic extra.
  if (flags & 0x04) {
    if (!need(bytes, i, 1)) {
      return { errors: ['payload truncated reading boot'] };
    }
    data.boot = bytes[i];
    i += 1;
    hasField = true;
  }

  // flags 0x08: particulate block. 7 PM mass concentrations (UFLT16 * 512,
  // ug/m3) then 3 particle counts (U32). No vocabulary home -> extras.
  if (flags & 0x08) {
    if (!need(bytes, i, 26)) {
      return { errors: ['payload truncated reading particulate block'] };
    }
    var pm = {};
    pm['0.1'] = round(uflt16(u16(bytes, i)) * 512, 4);
    i += 2;
    pm['0.3'] = round(uflt16(u16(bytes, i)) * 512, 4);
    i += 2;
    pm['0.5'] = round(uflt16(u16(bytes, i)) * 512, 4);
    i += 2;
    pm['1.0'] = round(uflt16(u16(bytes, i)) * 512, 4);
    i += 2;
    pm['2.5'] = round(uflt16(u16(bytes, i)) * 512, 4);
    i += 2;
    pm['5.0'] = round(uflt16(u16(bytes, i)) * 512, 4);
    i += 2;
    pm['10'] = round(uflt16(u16(bytes, i)) * 512, 4);
    i += 2;
    data.pm = pm;

    var pc = {};
    pc['1.0'] = u32(bytes, i);
    i += 4;
    pc['2.5'] = u32(bytes, i);
    i += 4;
    pc['10'] = u32(bytes, i);
    i += 4;
    data.pc = pc;
    hasField = true;
  }

  // flags 0x10: carbon monoxide (UFLT16 * 1000, ppm). Extra.
  if (flags & 0x10) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading CO'] };
    }
    data.coPpm = round(uflt16(u16(bytes, i)) * 1000, 4);
    i += 2;
    hasField = true;
  }

  // flags 0x20: nitrogen dioxide (UFLT16 * 10, ppm). Extra.
  if (flags & 0x20) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading NO2'] };
    }
    data.no2Ppm = round(uflt16(u16(bytes, i)) * 10, 4);
    i += 2;
    hasField = true;
  }

  // flags 0x40: ozone (UFLT16 * 30, ppm). Extra.
  if (flags & 0x40) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading O3'] };
    }
    data.o3Ppm = round(uflt16(u16(bytes, i)) * 30, 4);
    i += 2;
    hasField = true;
  }

  // flags 0x80: sulfur dioxide (UFLT16 * 30, ppm). Extra.
  if (flags & 0x80) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading SO2'] };
    }
    data.so2Ppm = round(uflt16(u16(bytes, i)) * 30, 4);
    i += 2;
    hasField = true;
  }

  // Unconditional: 4 gas-electrode rail voltages (int16 count, LSB = 1/4096 V).
  // These are always present in the record, regardless of the flag bitmap.
  // Diagnostic extras (no vocabulary home).
  if (!need(bytes, i, 8)) {
    return { errors: ['payload truncated reading gas-electrode voltages'] };
  }
  data.vCO = round(i16(bytes, i) / 4096.0, 4);
  i += 2;
  data.vNO2 = round(i16(bytes, i) / 4096.0, 4);
  i += 2;
  data.vO3 = round(i16(bytes, i) / 4096.0, 4);
  i += 2;
  data.vSO2 = round(i16(bytes, i) / 4096.0, 4);
  i += 2;
  hasField = true;

  // Second bitmap (environment / pressure / timestamp). It is optional: a
  // record may end after the gas-electrode voltages.
  if (need(bytes, i, 1)) {
    var flags2 = bytes[i];
    i += 1;

    // flags2 0x01: temperature + relative humidity.
    if (flags2 & 0x01) {
      if (!need(bytes, i, 4)) {
        return { errors: ['payload truncated reading temperature/humidity'] };
      }
      air.temperature = round(i16(bytes, i) / 256, 4);
      i += 2;
      air.relativeHumidity = round((u16(bytes, i) * 100) / 65535.0, 4);
      i += 2;
    }

    // flags2 0x02: barometric (atmospheric) pressure, LSB = 4 Pa -> hPa.
    if (flags2 & 0x02) {
      if (!need(bytes, i, 2)) {
        return { errors: ['payload truncated reading pressure'] };
      }
      air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
      i += 2;
    }

    // flags2 0x04: timestamp. Low bit selects the time source; the value is
    // (raw >> 1) * 2 + 17 seconds since the Unix epoch.
    if (flags2 & 0x04) {
      if (!need(bytes, i, 4)) {
        return { errors: ['payload truncated reading timestamp'] };
      }
      var rawTs = u32(bytes, i);
      i += 4;
      data.timeType = rawTs & 1 ? 'network time' : 'boot time';
      var seconds = Math.floor(rawTs / 2) * 2 + 17;
      data.time = new Date(seconds * 1000).toISOString();
    }
  }

  var hasAir = false;
  var ak;
  for (ak in air) {
    if (air.hasOwnProperty(ak)) {
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
