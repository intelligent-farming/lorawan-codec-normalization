// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for te-connectivity/8931ex
// (TE 8931EX — 3-axis-selectable wireless vibration condition monitor:
// RMS acceleration + FFT peak list + temperature, ATEX-certified).
//
// Ported from the upstream Apache-2.0 TheThingsNetwork decoder
// (TheThingsNetwork/lorawan-devices vendor/te-connectivity/universal_decoder.js,
// codecId "89xxex-codec", attributed in NOTICE). Only the 8931EX data frame
// (fPort 5, upstream Decode8931EX) is normalized here. The upstream
// dB-decompression math (Math.pow(10, ((v * 0.3149606) - 49.0298) / 20)) and
// the 19-bit-packed FFT peak layout (11-bit frequency + 8-bit dB-compressed
// magnitude) are reproduced faithfully. We author the normalization ourselves;
// upstream normalizeUplink is not copied.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Upstream dB-decompression for RMS acceleration / peak magnitudes (result in g).
function dBDecompression(val) {
  return Math.pow(10, ((val * 0.3149606) - 49.0298) / 20);
}

function bitfield(val, offset) {
  return (val >> offset) & 0x01;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 5) {
    return { errors: ['unsupported fPort ' + port + '; only the 8931EX data frame (fPort 5) is decoded'] };
  }
  // Header is 6 bytes; each peak adds 19 bits. Minimum is a 0-peak frame.
  if (!bytes || bytes.length < 6) {
    return { errors: ['payload too short for an 8931EX data frame'] };
  }

  var peakNb = bytes[4] & 0x3F;
  var needBytes = 6 + Math.ceil((peakNb * 19) / 8);
  if (bytes.length < needBytes) {
    return { errors: ['payload too short for declared peak count ' + peakNb] };
  }

  var data = {};

  // Battery state of charge: low nibble * 10 %, 0xF means an error reading.
  var batNibble = bytes[1] & 0x0F;
  if (batNibble !== 0x0F) {
    data.batteryPercent = batNibble * 10;
  }

  // Device status flags.
  data.deviceStatus = {
    rotation: (bitfield(bytes[1], 7) === 1) ? 'enabled' : 'disabled',
    temperature: (bitfield(bytes[1], 6) === 0) ? 'ok' : 'err',
    accelerometer: (bitfield(bytes[1], 5) === 0) ? 'ok' : 'err'
  };

  // Preset / measurement configuration id.
  data.presetId = bytes[0];

  // Temperature: bytes[2] * 0.5 - 40, already degrees Celsius.
  data.air = { temperature: round(bytes[2] * 0.5 - 40, 1) };

  // FFT bandwidth mode (vendor diagnostic).
  data.bandwidthMode = bytes[3] & 0x0F;

  // Selected measurement axis: bits 6-7 select X(0)/Y(1)/Z(2).
  var axis = String.fromCharCode(88 + (bytes[4] >> 6));

  // RMS acceleration (g), dB-decompressed from a single byte.
  data.vibration = {
    accelerationRms: round(dBDecompression(bytes[5]), 5)
  };
  data.axis = axis;

  // FFT peak list: peakNb entries, each packed as 19 bits MSB-first starting
  // at byte 6 — an 11-bit frequency (Hz) followed by an 8-bit dB-compressed
  // magnitude (g). Reproduces the upstream bit-walking loop exactly.
  var peaks = [];
  var peakVal = 0;
  var bitCount = 0;
  var total = peakNb * 19;
  for (var i = 0; i < total; i++) {
    peakVal |= ((bytes[6 + Math.floor(i / 8)] >> (8 - 1 - (i % 8))) & 0x01) << (19 - bitCount - 1);
    bitCount++;
    if (bitCount === 19) {
      peaks.push({
        freq: peakVal >> 8,
        mag: round(dBDecompression(peakVal & 0xFF), 5)
      });
      bitCount = 0;
      peakVal = 0;
    }
  }

  if (peaks.length > 0) {
    // Dominant frequency = the first (strongest) reported peak.
    data.vibration.peakFrequency = peaks[0].freq;
    data.peaks = peaks;
  }

  return { data: data };
}
