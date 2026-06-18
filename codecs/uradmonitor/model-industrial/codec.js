// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for uRADMonitor INDUSTRIAL (model-industrial), a
// multi-sensor industrial air-quality node: temperature, atmospheric pressure,
// humidity, a VOC gas-resistance reading, acoustic noise, up to four
// configurable electrochemical gas sensors, and particulate matter (PM1 / PM2.5
// / PM10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (fixed 50-byte big-endian frame) was understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/uradmonitor/industrial.js, attributed in NOTICE). The upstream decode
// logic is ported faithfully: signed-magnitude 16-bit floats, 24-bit unsigned
// fields, the offset-encoded pressure (raw + 65535, in Pa), the configurable
// electrochemical gas lookup, and the PM delta encoding (PM1 and PM10 are
// transmitted as deltas relative to PM2.5).
//
// Vocabulary mapping:
//   temperature  -> air.temperature      (signed-magnitude /100, deg C)
//   pressure     -> air.pressure         (Pa from upstream; /100 -> hPa, 900-1100)
//   humidity     -> air.relativeHumidity (raw /2, %RH)
// Everything the vocabulary does not model is emitted as a camelCase extra:
//   gasResistance (ohms), noise (dBA), iaq (index), pm1/pm25/pm10 (ug/m3),
//   and per-sensor gas concentrations o3/so2/no2/co/h2s/nh3/cl2 (ppm).
// The INDUSTRIAL has no CO2 sensor and reports no battery voltage/percentage in
// this frame, so air.co2, battery, and batteryPercent are not emitted.
//
// Frame layout (byte offsets, big-endian):
//   0..3   device ID                                          (not decoded)
//   4      hardware version            -> hardwareVersion "HW" + value
//   5      firmware version            -> firmwareVersion
//   6..9   timestamp (device uptime s)                        (not decoded)
//   10..19 GPS lat/lon/alt/speed (only on NMEA-equipped units; not decoded)
//   20..21 temperature  (signed-magnitude /100)
//   22..23 pressure     (uint16 + 65535, Pa)
//   24     humidity     (/2)
//   25..27 VOC gas resistance (uint24, ohms)
//   28     noise        (/2, dBA)
//   29     gas sensor 1 type   30..32 gas sensor 1 conc (uint24 /1000, ppm)
//   33     gas sensor 2 type   34..36 gas sensor 2 conc
//   37     gas sensor 3 type   38..40 gas sensor 3 conc
//   41     gas sensor 4 type   42..44 gas sensor 4 conc
//   45     PM1  delta (PM2.5 - PM1)
//   46..47 PM2.5 (uint16)
//   48     PM10 delta (PM10 - PM2.5)
//   49     CRC                                                (not checked)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function uint16(value1, value2) {
  return (value1 << 8) + value2;
}

function uint24(value1, value2, value3) {
  return (value1 << 16) + (value2 << 8) + value3;
}

// Signed-magnitude 24-bit: top bit is the sign, low 23 bits the magnitude.
function uint24float(value1, value2, value3, multiplier) {
  var value = uint24(value1, value2, value3);
  if (value & 0x800000) {
    return (value & 0x7fffff) / -multiplier;
  }
  return value / multiplier;
}

// Signed-magnitude 16-bit: top bit is the sign, low 15 bits the magnitude.
function uint16float(value1, value2, multiplier) {
  var value = uint16(value1, value2);
  if (value & 0x8000) {
    return (value & 0x7fff) / -multiplier;
  }
  return value / multiplier;
}

// Electrochemical gas-sensor type lookup, ported from the upstream
// decodeOrganicSensor table. Maps the 1-byte sensor ID to the gas symbol used
// as the extra key. An unconfigured/unknown slot (e.g. 0x00) returns null and
// is skipped.
function gasSymbol(type) {
  if (type === 0x2a) return 'o3';
  if (type === 0x2b) return 'so2';
  if (type === 0x2c) return 'no2';
  if (type === 0x04) return 'co';
  if (type === 0x03) return 'h2s';
  if (type === 0x02) return 'nh3';
  if (type === 0x31) return 'cl2';
  return null;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length !== 50) {
    return { errors: ['expected a 50-byte uRADMonitor INDUSTRIAL frame'] };
  }

  var air = {
    temperature: round(uint16float(bytes[20], bytes[21], 100), 2),
    // Upstream pressure is offset-encoded in Pa (raw + 65535); /100 -> hPa.
    pressure: round((uint16(bytes[22], bytes[23]) + 65535) / 100, 2),
    relativeHumidity: round(bytes[24] / 2, 1)
  };

  var data = {
    air: air,
    hardwareVersion: 'HW' + bytes[4],
    firmwareVersion: bytes[5],
    gasResistance: uint24(bytes[25], bytes[26], bytes[27]),
    noise: round(bytes[28] / 2, 1)
  };

  // Up to four configurable electrochemical gas sensors. Each pair is a 1-byte
  // type and a 3-byte signed-magnitude concentration (/1000 -> ppm). Unknown
  // slots are skipped, exactly as upstream does.
  var slots = [29, 33, 37, 41];
  for (var s = 0; s < slots.length; s++) {
    var off = slots[s];
    var symbol = gasSymbol(bytes[off]);
    if (symbol !== null) {
      data[symbol] = round(uint24float(bytes[off + 1], bytes[off + 2], bytes[off + 3], 1000), 3);
    }
  }

  // PM: PM2.5 is absolute; PM1 and PM10 are transmitted as deltas relative to
  // PM2.5 (PM1 = PM2.5 - delta, PM10 = PM2.5 + delta), ported from upstream.
  var pm25 = uint16(bytes[46], bytes[47]);
  data.pm1 = pm25 - bytes[45];
  data.pm25 = pm25;
  data.pm10 = pm25 + bytes[48];

  // uRADMonitor's air-quality index, ported (integer truncation of
  // ln(gasResistance) + 0.04 * humidity). gasResistance is always > 1 here so
  // the result is positive and Math.floor matches upstream's parseInt.
  data.iaq = Math.floor(Math.log(data.gasResistance) + 0.04 * air.relativeHumidity);

  return { data: data };
}
