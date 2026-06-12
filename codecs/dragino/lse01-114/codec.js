// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LSE01-114 (Soil Moisture & EC Sensor,
// firmware variant of LSE01 with an extra status-flag byte).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lse01-114.js, attributed in
// NOTICE). As with LSE01, the soil-temperature negative branch uses the correct
// two's-complement (- 0x10000) instead of upstream's off-by-one (- 0xffff).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var data = {};
  var air = {};
  var soil = {};

  // Bytes 0-1: battery voltage, low 14 bits, mV -> V.
  var battRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
  data.battery = round(battRaw / 1000, 3);

  // Bytes 2-3: DS18B20 external probe temperature (air), signed, 0.1 C.
  var tRaw = (bytes[2] << 8) | bytes[3];
  if (tRaw & 0x8000) {
    tRaw = tRaw - 0x10000;
  }
  air.temperature = round(tRaw / 10, 1);

  // Bytes 4-5: soil moisture, 0.01 %.
  var mRaw = (bytes[4] << 8) | bytes[5];
  soil.moisture = round(mRaw / 100, 2);

  // Bytes 6-7: soil temperature, signed, 0.01 C.
  var stRaw = (bytes[6] << 8) | bytes[7];
  if (stRaw & 0x8000) {
    stRaw = stRaw - 0x10000;
  }
  soil.temperature = round(stRaw / 100, 2);

  // Bytes 8-9: soil EC, upstream uS/cm -> dS/m (/1000).
  var ecRaw = (bytes[8] << 8) | bytes[9];
  soil.ec = round(ecRaw / 1000, 3);

  data.air = air;
  data.soil = soil;

  // Byte 10: status flags (device-specific extras).
  data.sensorFlag = bytes[10] >> 4;
  data.interruptFlag = bytes[10] & 0x0f;
  data.hardwareFlag = (bytes[10] >> 2) & 0x01;

  return { data: data };
}
