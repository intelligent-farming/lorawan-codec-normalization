// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LSE01 (Soil Moisture & EC Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lse01.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
// Note: the upstream soil-temperature decode uses `(value - 0xffff)` for
// negatives, which is off by one count (0.01 C). This codec uses the correct
// two's-complement `(value - 0x10000)`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length < 10) {
    return { errors: ['expected at least 10 bytes, got ' + bytes.length] };
  }

  var data = {};
  var air = {};
  var soil = {};

  // Bytes 0-1: battery voltage, low 14 bits, millivolts -> volts.
  var battRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
  data.battery = round(battRaw / 1000, 3);

  // Bytes 2-3: DS18B20 external probe temperature (treated as air), signed
  // 16-bit, units 0.1 C.
  var tRaw = (bytes[2] << 8) | bytes[3];
  if (tRaw & 0x8000) {
    tRaw = tRaw - 0x10000;
  }
  air.temperature = round(tRaw / 10, 1);

  // Bytes 4-5: soil moisture, units 0.01 %.
  var mRaw = (bytes[4] << 8) | bytes[5];
  soil.moisture = round(mRaw / 100, 2);

  // Bytes 6-7: soil temperature, signed 16-bit, units 0.01 C.
  var stRaw = (bytes[6] << 8) | bytes[7];
  if (stRaw & 0x8000) {
    stRaw = stRaw - 0x10000;
  }
  soil.temperature = round(stRaw / 100, 2);

  // Bytes 8-9: soil electrical conductivity, upstream uS/cm -> dS/m (/1000).
  var ecRaw = (bytes[8] << 8) | bytes[9];
  soil.ec = round(ecRaw / 1000, 3);

  data.air = air;
  data.soil = soil;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lse01";
  }
  return result;
}
