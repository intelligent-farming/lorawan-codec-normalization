// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LAQ4 (Indoor Air Quality Sensor:
// CO2, temperature, humidity, TVOC).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/laq4.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// fPort 2 carries one of two frames, selected by the work-mode nibble in
// bits 6..2 of byte 2: mode 1 ("CO2") is the periodic measurement frame;
// mode 31 ("ALARM") reports the configured alarm thresholds, not live
// readings. CO2 -> air.co2 (ppm), SHT temperature -> air.temperature,
// SHT humidity -> air.relativeHumidity, battery volts -> battery, and the
// device's TVOC reading and alarm flag are carried as camelCase extras.
// The threshold (ALARM) frame holds no normalized measurements, so its
// values are surfaced verbatim as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16(hi, lo) {
  var v = ((hi << 8) | lo) & 0xffff;
  return v & 0x8000 ? v - 0x10000 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unknown FPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var mode = (bytes[2] & 0x7c) >> 2;
  var data = {};

  // Bytes 0-1: battery voltage, millivolts -> volts.
  data.battery = round(((bytes[0] << 8) | bytes[1]) / 1000, 3);

  if (mode === 1) {
    // Periodic CO2 measurement frame.
    var air = {};
    air.location = 'indoor';
    // Bytes 5-6: CO2 concentration (ppm).
    air.co2 = (bytes[5] << 8) | bytes[6];
    // Bytes 7-8: SHT temperature, signed 16-bit, units 0.1 C.
    air.temperature = round(s16(bytes[7], bytes[8]) / 10, 2);
    // Bytes 9-10: SHT relative humidity, units 0.1 %.
    air.relativeHumidity = round(((bytes[9] << 8) | bytes[10]) / 10, 1);
    data.air = air;
    // Byte 3-4: TVOC concentration (ppb); byte 2 bit 0: alarm flag.
    data.tvoc = (bytes[3] << 8) | bytes[4];
    data.alarmStatus = (bytes[2] & 0x01) ? true : false;
  } else if (mode === 31) {
    // Alarm-threshold frame: configured limits, not live measurements.
    data.workMode = 'alarm';
    data.tempMin = (bytes[3] << 24) >> 24;
    data.tempMax = (bytes[4] << 24) >> 24;
    data.humidityMin = bytes[5];
    data.humidityMax = bytes[6];
    data.co2Min = (bytes[7] << 8) | bytes[8];
    data.co2Max = (bytes[9] << 8) | bytes[10];
  } else {
    return { errors: ['unsupported work mode ' + mode] };
  }

  return { data: data };
}
