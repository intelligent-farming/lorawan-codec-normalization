// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for senzemo/ssm30 (Senzemo Senstick SSM30 soil
// moisture sensor with onboard climate, Pino Tech soil probe). Authored from
// the upstream Apache-2.0 Senzemo SSM30 decoder (attributed in NOTICE).
//
// fPort 1/2 data packet (10 bytes): status b0; air temperature b1..2 signed/100
// -> air.temperature; humidity b3..4 /100 -> air.relativeHumidity; air pressure
// b5..6 /10 (hPa) -> air.pressure; battery level (b7+100)/100 -> battery (V);
// soil probe voltage b8..9 mV converted to volumetric water content (cubic) ->
// soil.moisture (%), with the linear voltage-range percentage and raw mV as
// extras. Other fPorts are device configuration and return an error.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 1 && input.fPort !== 2) { return { errors: ['fPort ' + input.fPort + ' is a config frame, not a data packet'] }; }
  if (!b || b.length < 10) { return { errors: ['payload too short (need >= 10 bytes)'] }; }
  var mv = ((b[8] & 0xff) << 8) | b[9];
  var v = mv / 1000;
  var sm = Math.round((mv - 44) * 100 / (2876 - 44));
  if (sm > 100) { sm = 100; } else if (sm < 0) { sm = 0; }
  var vwc = Math.round((2.8432 * v * v * v) - (9.1993 * v * v) + (20.2553 * v) - 4.1882);
  if (vwc < 0) { vwc = 0; }
  var data = {};
  data.air = {
    temperature: round(s16(b[1], b[2]) / 100, 2),
    relativeHumidity: round((((b[3] & 0xff) << 8) | b[4]) / 100, 2),
    pressure: round((((b[5] & 0xff) << 8) | b[6]) / 10, 1)
  };
  data.battery = round((b[7] + 100) / 100, 2);
  data.soil = { moisture: vwc };
  data.soilMoisturePercent = sm;
  data.soilMoistureRaw = mv;
  data.status = b[0];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "senzemo"; result.data.model = "ssm30"; }
  return result;
}
