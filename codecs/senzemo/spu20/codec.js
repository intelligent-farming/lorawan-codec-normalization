// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Senzemo SPU20 (Senspuck Pure PV) — an indoor
// LoRaWAN air-quality sensor measuring CO2, TVOC, temperature, relative
// humidity, and pressure.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed-layout big-endian frames keyed by total length) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/senzemo/spu20.js, attributed in
// NOTICE). We do NOT copy upstream normalizeUplink; we author the normalization.
//
// Frames:
//   15-byte DATA packet:   Status, Temperature(s16/100 °C), Humidity(u16/100 %),
//                          AirPressure(u16/10 hPa), TVOC(u16/100), CO2(u16 ppm),
//                          Voltage(u16 mV), 2 trailing bytes (reserved).
//   10-byte CONFIG packet:  device configuration only — no climate measurement,
//                          so we surface it as an error rather than empty data.
//
// Mappings:
//   Temperature -> air.temperature (°C)
//   Humidity    -> air.relativeHumidity (%)
//   AirPressure -> air.pressure (hPa, atmospheric)
//   CO2         -> air.co2 (ppm)
//   Voltage     -> battery (mV / 1000 -> V; SPU20 is solar-PV supplied)
//   TVOC        -> tvoc (camelCase extra; no vocabulary key for TVOC)
//   Status      -> status (camelCase extra; device status byte)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  // CONFIG packet carries no climate measurement.
  if (bytes.length === 10) {
    return { errors: ['config packet (no measurement)'] };
  }

  if (bytes.length !== 15) {
    return { errors: ['unexpected payload length ' + bytes.length] };
  }

  var air = {};
  air.temperature = round(s16be(bytes[1], bytes[2]) / 100, 2);
  air.relativeHumidity = round(u16be(bytes[3], bytes[4]) / 100, 2);
  air.pressure = round(u16be(bytes[5], bytes[6]) / 10, 1);
  air.co2 = u16be(bytes[9], bytes[10]);

  var data = {};
  data.air = air;
  data.battery = round(u16be(bytes[11], bytes[12]) / 1000, 3);
  data.tvoc = round(u16be(bytes[7], bytes[8]) / 100, 2);
  data.status = bytes[0];

  return { data: data };
}
