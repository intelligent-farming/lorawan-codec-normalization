// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for uRADMonitor MODEL A3 (multi-sensor air-quality
// monitor: temperature, barometric pressure, humidity, VOC gas resistance,
// noise, CO2, formaldehyde, ozone and particulate matter).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed 32-byte uRADMonitor A3 frame) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/uradmonitor/a3.js, attributed in NOTICE). The decode logic is ported
// faithfully from that reference; only the output shape is re-authored onto the
// shared vocabulary.
//
// Field layout (bytes, big-endian):
//   [4]      hardware version  -> "HW" + value
//   [5]      firmware version
//   [10..11] temperature, sign-magnitude (bit 0x8000), /100 -> air.temperature C
//   [12..13] pressure, uint16 + 65535 -> Pa; /100 -> air.pressure hPa
//   [14]     humidity / 2 -> air.relativeHumidity %
//   [15..17] VOC gas resistance, uint24 -> gasResistance (ohms, extra)
//   [18]     sound / 2 -> noise (dBA, extra)
//   [19..20] CO2, uint16 -> air.co2 ppm
//   [21..22] formaldehyde, uint16 -> hcho (ppb, extra)
//   [23..24] ozone, uint16 -> o3 (ppb, extra)
//   [25..26] PM1, uint16 -> pm1 (ug/m3, extra)
//   [27..28] PM2.5, uint16 -> pm25 (ug/m3, extra)
//   [29..30] PM10, uint16 -> pm10 (ug/m3, extra)
//   [31]     CRC (ignored)
//
// uRADMonitor reports no battery telemetry in this frame, so neither `battery`
// (volts) nor `batteryPercent` is emitted.

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

function uint16float(value1, value2, multiplier) {
  var value = uint16(value1, value2);
  if (value & 0x8000) {
    return (value & 0x7fff) / -multiplier;
  }
  return value / multiplier;
}

// Truncate toward zero, matching the upstream parseInt(number) behaviour.
function trunc(value) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (bytes.length !== 32) {
    return { errors: ['expected 32-byte uRADMonitor A3 frame, got ' + bytes.length] };
  }

  var temperature = uint16float(bytes[10], bytes[11], 100);
  var pressurePa = uint16(bytes[12], bytes[13]) + 65535;
  var humidity = bytes[14] / 2;
  var gasResistance = uint24(bytes[15], bytes[16], bytes[17]);
  var noise = bytes[18] / 2;
  var co2 = uint16(bytes[19], bytes[20]);
  var hcho = uint16(bytes[21], bytes[22]);
  var o3 = uint16(bytes[23], bytes[24]);
  var pm1 = uint16(bytes[25], bytes[26]);
  var pm25 = uint16(bytes[27], bytes[28]);
  var pm10 = uint16(bytes[29], bytes[30]);

  // Indoor air-quality index, as derived upstream.
  var iaq = trunc(Math.log(gasResistance) + 0.04 * humidity);

  var air = {
    temperature: round(temperature, 2),
    relativeHumidity: round(humidity, 1),
    co2: co2
  };

  // Pressure is mapped to the atmospheric vocabulary key only when it falls in
  // the modelled barometric range (900-1100 hPa).
  var pressureHpa = round(pressurePa / 100, 2);
  if (pressureHpa >= 900 && pressureHpa <= 1100) {
    air.pressure = pressureHpa;
  }

  var data = {
    air: air,
    deviceModel: 'A3',
    hardwareVersion: 'HW' + bytes[4],
    firmwareVersion: bytes[5],
    gasResistance: gasResistance,
    noise: round(noise, 1),
    hcho: hcho,
    o3: o3,
    pm1: pm1,
    pm25: pm25,
    pm10: pm10,
    iaq: iaq
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "uradmonitor";
    result.data.model = "model-a3";
  }
  return result;
}
