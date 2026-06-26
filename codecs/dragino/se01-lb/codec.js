// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/se01-lb (Dragino SE01-LB/LS LoRaWAN soil
// moisture / EC / temperature sensor).
//
// Wire format authored from the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/se01-lb.js, attributed in
// NOTICE; the upstream file stores the JS with escaped newlines). Original
// normalization; upstream normalizeUplink is not copied.
//
// fPort 2 measurement (bytes[10] bit7 = MOD; MOD 0 = calibrated):
//   bytes[0..1] battery ((hi<<8|lo)&0x3FFF)/1000 -> battery (V)
//   bytes[2..3] DS18B20 external probe temp (signed/10) -> probeTemperature (extra)
//   MOD 0: bytes[4..5] moisture/100 (%) -> soil.moisture; bytes[6..7] signed/100
//          -> soil.temperature (C); bytes[8..9] EC (uS/cm) -> soil.ec (dS/m, /1000)
//   MOD 1: raw dielectric/moisture/conductivity counts -> camelCase extras
// fPort 3 (datalog) and fPort 5 (device info) carry no normalized measurement.

function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 3) { return { errors: ['datalog frame (fPort 3) not normalized'] }; }
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 11) { return { errors: ['payload too short (need >= 11 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.probeTemperature = round(s16(b[2], b[3]) / 10, 2);
  var mod = (b[10] >> 7) & 0x01;
  if (mod === 0) {
    data.soil = {
      moisture: round((((b[4] & 0xff) << 8) | b[5]) / 100, 2),
      temperature: round(s16(b[6], b[7]) / 100, 2),
      ec: round((((b[8] & 0xff) << 8) | b[9]) / 1000, 4)
    };
  } else {
    data.soilDielectricConstant = round((((b[4] & 0xff) << 8) | b[5]) / 10, 1);
    data.rawMoistureSoil = ((b[6] & 0xff) << 8) | b[7];
    data.rawConductSoil = ((b[8] & 0xff) << 8) | b[9];
  }
  data.mod = mod;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "se01-lb";
  }
  return result;
}
