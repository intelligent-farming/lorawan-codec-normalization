// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for watteco/ticso (Watteco TIC meter interface: active/
// reactive energy and power metering).
//
// Original work. The upstream Apache-2.0 decoder is a webpacked bundle and is
// not console-safe, so this Watteco ZCL standard-report parser is authored here
// (attribution in NOTICE). On fPort 125 a report carries frame-control (byte 0),
// command (byte 1), 16-bit cluster (bytes 2-3), 16-bit attribute (bytes 4-5).
// The energy/power cluster 0x0052 attr 0x0000 is an octet string (type 0x41,
// byte 6) of length byte 7, then a 12-byte block decoded as:
//   active_energy   s24 BE (Wh)  -> metering.energy.total
//   reactive_energy s24 BE (varh)-> camelCase extra
//   nb_samples      u16 BE       -> camelCase extra
//   active_power    s16 BE (W)   -> power.active
//   reactive_power  s16 BE (var) -> camelCase extra
// On/off state (cluster 0x0006) -> camelCase extra. Batch reports (frame control
// bit0 clear) need per-device coding tables and are reported as an error.

function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function u16be(hi, lo) { return ((hi << 8) | lo) & 0xffff; }
function s16be(hi, lo) { var v = u16be(hi, lo); return (v & 0x8000) ? v - 0x10000 : v; }
function u24be(b0, b1, b2) { return ((b0 & 0xff) << 16) + ((b1 & 0xff) << 8) + (b2 & 0xff); }
function s24be(b0, b1, b2) { var v = u24be(b0, b1, b2); return (v & 0x800000) ? v - 0x1000000 : v; }

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (input.fPort !== 125) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 125)'] }; }
  if (!bytes || bytes.length < 6) { return { errors: ['payload too short for a Watteco ZCL report'] }; }
  if ((bytes[0] & 0x01) === 0) { return { errors: ['batch report not supported (requires per-device coding tables)'] }; }
  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);
  var data = {};
  if (cmd === 0x0a) {
    if (cluster === 82 && attr === 0) {
      // octet string: byte 6 type (0x41), byte 7 length, block from byte 8
      var b = 8;
      if (bytes.length < b + 12) { return { errors: ['energy report too short'] }; }
      data.metering = { energy: { total: s24be(bytes[b], bytes[b + 1], bytes[b + 2]) } };
      data.power = { active: s16be(bytes[b + 8], bytes[b + 9]) };
      data.reactiveEnergy = s24be(bytes[b + 3], bytes[b + 4], bytes[b + 5]);
      data.sampleCount = u16be(bytes[b + 6], bytes[b + 7]);
      data.reactivePower = s16be(bytes[b + 10], bytes[b + 11]);
      return { data: data };
    }
    if (cluster === 6 && attr === 0) {
      data.relayState = (bytes[bytes.length - 1] & 0x01) ? 'on' : 'off';
      return { data: data };
    }
    if (cluster === 80 && attr === 6) {
      var flags = bytes[9]; var p = 10; var voltage;
      var bit;
      for (bit = 0; bit < 5; bit++) { if ((flags & (1 << bit)) && p + 1 < bytes.length) { voltage = u16be(bytes[p], bytes[p + 1]) / 1000; break; } }
      if (voltage === undefined) { return { errors: ['power report carried no battery source'] }; }
      data.battery = round(voltage, 3);
      return { data: data };
    }
    return { errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr] };
  }
  if (cmd === 0x01) {
    if (cluster === 32772 && attr === 0 && bytes.length > 8) { data.messageType = bytes[8] === 1 ? 'confirmed' : 'unconfirmed'; return { data: data }; }
    return { errors: ['unrecognized Watteco config cluster ' + cluster + ' attribute ' + attr] };
  }
  return { errors: ['unsupported Watteco command 0x' + cmd.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "ticso";
  }
  return result;
}
