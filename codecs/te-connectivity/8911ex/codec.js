// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TE Connectivity 8911EX (single-axis vibration
// condition monitor: RMS acceleration + FFT peak list + temperature + battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/te-connectivity/universal_decoder.js,
// function Decode8911EX, attributed in NOTICE). The little-endian field offsets,
// the temperature transfer function ((raw/10)-100), the sig_rms and peak
// magnitude scaling (raw/1000), and the peak-loop length guard are reproduced
// faithfully from that decoder; the normalization to the shared vocabulary is
// authored here (upstream te_decoder / decode object is NOT copied).
//
// Frame (fPort 1):
//   bytes[0]      battery (percent, 0..100)
//   bytes[1]      peak_nb (advertised FFT peak count)
//   bytes[2..3]   temperature, uint16 LE; 0x7FFF = sensor error, else (raw/10)-100 (deg C)
//   bytes[4..5]   sig_rms, uint16 LE; raw/1000 (g, RMS acceleration)
//   bytes[6]      preset id
//   bytes[7]      device status bitfield
//   bytes[8..]    FFT peaks, 5 bytes each: freq uint16 LE, mag uint16 LE (/1000), ratio uint8
// The upstream peak loop terminates at ((i*5+5) < (bytes.length-8)), so the
// number of peaks actually emitted is bounded by the frame length and may be
// fewer than peak_nb. We reproduce that bound exactly. The dominant peak (first
// entry) frequency becomes vibration.peakFrequency.
//
// Mapping to the shared vocabulary:
//   sig_rms          -> vibration.accelerationRms (g)
//   peaks[0].freq    -> vibration.peakFrequency (Hz)
//   full peak list   -> camelCase extra `peaks` (device-specific FFT spectrum)
//   temperature      -> air.temperature (deg C)
//   battery percent  -> camelCase extra `batteryPercent` (device reports %, not V)
//   device status    -> camelCase extra `deviceStatus`
//   preset id        -> camelCase extra `preset`
//
// Banned in the TTN/ChirpStack console sandbox and therefore avoided here:
//   require, import/export, module.exports, exports., process, Buffer,
//   globalThis, eval, new Function, timers, console, fetch, async/await,
//   Promise, optional chaining (?.), nullish (??), spread/rest (...), BigInt,
//   private (#) fields, static blocks. ES5-style only.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function uint16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
}

function bitfield(val, offset) {
  return (val >> offset) & 0x01;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 1) {
    return { errors: ['unsupported fPort ' + fPort + ': only the 8911EX vibration frame (fPort 1) is normalized'] };
  }
  if (!bytes || bytes.length < 8) {
    return { errors: ['payload too short: 8911EX vibration frame needs at least 8 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data = {};
  var warnings = [];

  // battery percent (device reports %, not volts) -> extra
  data.batteryPercent = bytes[0];

  var peakNb = bytes[1];

  // temperature: uint16 LE, 0x7FFF = sensor error
  var rawTemp = uint16LE(bytes, 2);
  if (rawTemp === 0x7fff) {
    warnings.push('temperature sensor reported error (0x7FFF)');
  } else {
    data.air = { temperature: round(rawTemp / 10.0 - 100, 1) };
  }

  // RMS acceleration (g)
  var accelerationRms = round(uint16LE(bytes, 4) / 1000.0, 3);

  var vibration = { accelerationRms: accelerationRms };

  // preset id
  data.preset = bytes[6];

  // device status bitfield
  var status = bytes[7];
  data.deviceStatus = {
    acc: bitfield(status, 5) === 0 ? 'ok' : 'err',
    temp: bitfield(status, 6) === 0 ? 'ok' : 'err',
    rotEn: bitfield(status, 7) === 1 ? 'enabled' : 'disabled',
    com: bitfield(status, 3) === 0 ? 'ok' : 'err',
    battery: bitfield(status, 0) === 0 ? 'ok' : 'err'
  };

  // FFT peaks: 5 bytes each from offset 8. Reproduce the upstream length guard
  // ((i*5+5) < (bytes.length-8)) exactly, which bounds the emitted count by the
  // frame length and may be fewer than peakNb.
  var peaks = [];
  for (var i = 0; i < peakNb && i * 5 + 5 < bytes.length - 8; i++) {
    peaks.push({
      freq: uint16LE(bytes, 5 * i + 8),
      mag: round(uint16LE(bytes, 5 * i + 10) / 1000.0, 3),
      ratio: bytes[5 * i + 12]
    });
  }
  data.peaks = peaks;

  // dominant peak frequency -> vibration.peakFrequency
  if (peaks.length > 0) {
    vibration.peakFrequency = peaks[0].freq;
  }

  data.vibration = vibration;

  var out = { data: data };
  if (warnings.length > 0) {
    out.warnings = warnings;
  }
  return out;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "te-connectivity";
    result.data.model = "8911ex";
  }
  return result;
}
