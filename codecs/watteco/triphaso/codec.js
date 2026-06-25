// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for watteco/triphaso (Watteco three-phase energy
// meter).
//
// Original work. The upstream Apache-2.0 decoder is a webpacked bundle (not
// console-safe), so this Watteco ZCL standard-report parser is authored here
// (attribution in NOTICE). On fPort 125 the three-phase energy cluster 0x800A
// attr 0x0000 is an octet string (type 0x41, byte 6; length byte 7) carrying
// four u32 BE totals from byte 8:
//   positive_active_energy_abc   (Wh)   -> metering.energy.total
//   negative_active_energy_abc   (Wh)   -> camelCase extra
//   positive_reactive_energy_abc (varh) -> camelCase extra
//   negative_reactive_energy_abc (varh) -> camelCase extra
// Battery (cluster 0x0050) and message-type config are handled as in the Watteco
// framework. Batch reports (frame-control bit0 clear) -> error.

function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function u16be(hi, lo) { return ((hi << 8) | lo) & 0xffff; }
function u32be(b0, b1, b2, b3) { return ((b0 & 0xff) * 16777216) + ((b1 & 0xff) << 16) + ((b2 & 0xff) << 8) + (b3 & 0xff); }

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (input.fPort !== 125) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 125)'] }; }
  if (!bytes || bytes.length < 6) { return { errors: ['payload too short for a Watteco ZCL report'] }; }
  if ((bytes[0] & 0x01) === 0) { return { errors: ['batch report not supported (requires per-device coding tables)'] }; }
  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);
  var data = {};
  if (cmd === 0x0a && cluster === 32778 && attr === 0) {
    var b = 8;
    if (bytes.length < b + 16) { return { errors: ['three-phase energy report too short'] }; }
    data.metering = { energy: { total: u32be(bytes[b], bytes[b + 1], bytes[b + 2], bytes[b + 3]) } };
    data.negativeActiveEnergy = u32be(bytes[b + 4], bytes[b + 5], bytes[b + 6], bytes[b + 7]);
    data.positiveReactiveEnergy = u32be(bytes[b + 8], bytes[b + 9], bytes[b + 10], bytes[b + 11]);
    data.negativeReactiveEnergy = u32be(bytes[b + 12], bytes[b + 13], bytes[b + 14], bytes[b + 15]);
    return { data: data };
  }
  if (cmd === 0x0a && cluster === 80 && attr === 6) {
    var flags = bytes[9]; var p = 10; var voltage; var bit;
    for (bit = 0; bit < 5; bit++) { if ((flags & (1 << bit)) && p + 1 < bytes.length) { voltage = u16be(bytes[p], bytes[p + 1]) / 1000; break; } }
    if (voltage === undefined) { return { errors: ['power report carried no battery source'] }; }
    data.battery = round(voltage, 3); return { data: data };
  }
  if (cmd === 0x01 && cluster === 32772 && attr === 0 && bytes.length > 8) {
    data.messageType = bytes[8] === 1 ? 'confirmed' : 'unconfirmed'; return { data: data };
  }
  return { errors: ['unrecognized Watteco frame (cluster ' + cluster + ' attr ' + attr + ' cmd 0x' + cmd.toString(16) + ')'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "triphaso";
  }
  return result;
}
