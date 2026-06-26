// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/s31-lb (Dragino S31-LB/LS temperature &
// humidity sensor, an SHT-equipped LSN50-family node). Authored from the
// upstream Apache-2.0 Dragino decoder (attributed in NOTICE; upstream stores JS
// with escaped newlines).
//
// fPort 2: the work mode is (b6 & 0x7C) >> 2. The S31-LB operates in IIC/SHT
// mode (mode 0): battery (b0<<8|b1)/1000; onboard temperature b2..3 signed/10
// (extra); ADC b4..5 (extra); external SHT temperature b7..8 signed/10 ->
// air.temperature; SHT humidity b9..10 /10 -> air.relativeHumidity. When
// b9..10 == 0 the frame carries illuminance instead of humidity and cannot
// satisfy the climate contract, so it is reported as an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 11) { return { errors: ['payload too short (need >= 11 bytes)'] }; }
  var mode = (b[6] & 0x7c) >> 2;
  if (mode !== 0) { return { errors: ['work mode ' + mode + ' is not the IIC/SHT climate mode'] }; }
  var humRaw = ((b[9] & 0xff) << 8) | (b[10] & 0xff);
  if (humRaw === 0) { return { errors: ['frame carries illuminance, not temperature/humidity'] }; }
  var data = {};
  data.battery = round((((b[0] & 0xff) << 8) | b[1]) / 1000, 3);
  data.air = { temperature: round(s16(b[7], b[8]) / 10, 2), relativeHumidity: round(humRaw / 10, 1) };
  data.onboardTemperature = round(s16(b[2], b[3]) / 10, 2);
  data.adcVoltage = round((((b[4] & 0xff) << 8) | b[5]) / 1000, 3);
  data.digitalInputHigh = (b[6] & 0x02) ? true : false;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "s31-lb"; }
  return result;
}
