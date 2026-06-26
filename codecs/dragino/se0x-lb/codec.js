// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/se0x-lb (Dragino SE0X-LB/LS multi-channel
// soil moisture / temperature / EC sensor, up to 4 probes). Authored from the
// upstream Apache-2.0 Dragino SE0X-LB decoder (attributed in NOTICE).
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; DS18B20 air/probe temperature
// b2..3 signed/10 (extra); b4 holds the mode bit (bit7: 0=calibrated) and a
// 4-bit channel-present mask in the low nibble (bit3=ch1 .. bit0=ch4). Each
// present channel n occupies a 6-byte block at j=6*(n-1): moisture
// (b[5+j]<<8|b[6+j])/100 %, temperature signed(b[7+j],b[8+j])/100 C, EC raw
// (b[9+j]<<8|b[10+j]) µS/cm. Channel 1 -> soil.moisture / soil.temperature /
// soil.ec (µS/cm -> dS/m, /1000); channels 2-4, when present, are camelCase
// extras. The raw/uncalibrated mode (bit7=1) reports dielectric constants
// instead of calibrated values and is surfaced as extras without soil.* keys.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 11) { return { errors: ['payload too short (need >= 11 bytes for one channel)'] }; }
  var calibrated = ((b[4] >> 7) & 0x01) === 0;
  var mask = b[4] & 0x0f;
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.probeTemperature = round(s16(b[2], b[3]) / 10, 2);
  data.channelMask = mask;
  var labels = ['Channel1', 'Channel2', 'Channel3', 'Channel4'];
  var n;
  for (n = 0; n < 4; n++) {
    if (!((mask >> (3 - n)) & 0x01)) { continue; }
    var j = 6 * n;
    if (b.length < 11 + j) { break; }
    var moisture = round((((b[5 + j] & 0xff) << 8) | b[6 + j]) / 100, 2);
    if (calibrated) {
      var temp = round(s16(b[7 + j], b[8 + j]) / 100, 2);
      var ecUs = ((b[9 + j] & 0xff) << 8) | b[10 + j];
      if (n === 0) {
        data.soil = { moisture: moisture, temperature: temp, ec: round(ecUs / 1000, 3) };
      } else {
        data['moistureSoil' + (n + 1)] = moisture;
        data['temperatureSoil' + (n + 1)] = temp;
        data['ecSoil' + (n + 1)] = round(ecUs / 1000, 3);
      }
    } else {
      data['dielectric' + labels[n]] = round((((b[5 + j] & 0xff) << 8) | b[6 + j]) / 10, 1);
      data['rawWater' + labels[n]] = ((b[7 + j] & 0xff) << 8) | b[8 + j];
      data['rawConduct' + labels[n]] = ((b[9 + j] & 0xff) << 8) | b[10 + j];
    }
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "se0x-lb"; }
  return result;
}
