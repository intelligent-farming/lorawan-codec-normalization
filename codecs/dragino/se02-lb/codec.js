// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/se02-lb (Dragino SE02-LB/LS 2-channel soil moisture/EC/temperature sensor).
//
// Wire format authored from the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/se02-lb.js, attributed in
// NOTICE; upstream stores the JS with escaped newlines). Original normalization.
//
// fPort 2: battery (bytes[0..1]); DS18B20 probe temp (bytes[2..3] signed/10);
// channel 1 moisture bytes[4..5]/100 (%) -> soil.moisture, temp bytes[6..7]
// signed/100 -> soil.temperature, EC bytes[8..9] uS/cm -> soil.ec (dS/m);
// channel 2 (bytes[10..15]) as camelCase extras.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 16) { return { errors: ['payload too short (need >= 16 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.probeTemperature = round(s16(b[2], b[3]) / 10, 2);
  data.soil = {
    moisture: round((((b[4] & 0xff) << 8) | b[5]) / 100, 2),
    temperature: round(s16(b[6], b[7]) / 100, 2),
    ec: round((((b[8] & 0xff) << 8) | b[9]) / 1000, 4)
  };
  data.moistureSoil2 = round((((b[10] & 0xff) << 8) | b[11]) / 100, 2);
  data.tempSoil2 = round(s16(b[12], b[13]) / 100, 2);
  data.ecSoil2 = ((b[14] & 0xff) << 8) | b[15];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "se02-lb"; }
  return result;
}
