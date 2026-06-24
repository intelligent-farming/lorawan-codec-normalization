// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for nke-watteco Skydome (window position /
// inclination sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nke-watteco/skydome-sensor.js, attributed in NOTICE). Ported from that
// decoder's standard-report path (Decoder() port===125, decodedBatch===false);
// do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when CLEAR the frame is a Huffman-compressed "batch" frame (upstream
// brUncompress) which this codec does NOT decode and reports as an error; when
// SET the frame is a ZCL standard report. A standard data report carries the
// frame control (byte 0), command id (byte 1), 16-bit cluster id (bytes 2-3),
// 16-bit attribute id (bytes 4-5), a report-parameters byte (byte 6) and then
// the attribute value. Value offset is 7 for data/alarm reports (cmd 0x0A /
// 0x8A) and 8 for the read-attribute response (cmd 0x01).
//
// Measurement-bearing clusters mapped to the shared vocabulary:
//   cluster 0x000C (12) attr 0x0055 (85) analog input -> tilt.angle (IEEE754
//       float32 big-endian, degrees of inclination from reference)
//   cluster 0x0050 (80) attr 0x0006 (6) power descriptor -> battery (mV / 1000,
//       volts)
// The lorawan-configuration cluster 0x8004 (32772) attr 0 (message type)
// carries no measurement and is surfaced as the camelCase extra `messageType`.
//
// Divergence from upstream: upstream's power-descriptor handler writes a
// rechargeable/solar/TIC source onto `decoded.data` before that field is the
// measurement array, throwing on those sources. This port mirrors the
// nke-watteco TH / Atm'O codecs instead: it emits the first present power
// source as the volts `battery` reading without crashing.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// Decode a 32-bit IEEE754 big-endian float from four bytes. Mirrors upstream
// Bytes2Float32; pure integer/Math arithmetic, no Buffer/DataView (console-safe).
function bytes2Float32(b0, b1, b2, b3) {
  var bits = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  var sign = bits & 0x80000000 ? -1 : 1;
  var exponent = ((bits >> 23) & 0xff) - 127;
  var significand = bits & 0x7fffff;
  if (exponent === 128) {
    return sign * (significand ? NaN : Infinity);
  }
  if (exponent === -127) {
    if (significand === 0) {
      return sign * 0.0;
    }
    exponent = -126;
    significand = significand / (1 << 23);
  } else {
    significand = (significand | (1 << 23)) / (1 << 23);
  }
  return sign * significand * Math.pow(2, exponent);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 125) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 125)'] };
  }
  if (!bytes || bytes.length < 6) {
    return { errors: ['payload too short for a Watteco ZCL report'] };
  }
  // Byte 0 bit0 clear => Huffman batch frame (upstream brUncompress); unsupported.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Huffman batch frames are not supported'] };
  }

  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  // Standard data report (cmd 0x0A) or alarm report (cmd 0x8A): value at index 7.
  // Read-attribute response (cmd 0x01): a status byte sits at index 6, value at 8.
  var h;
  if (cmd === 0x0a || cmd === 0x8a) {
    h = 7;
  } else if (cmd === 0x01) {
    h = 8;
  } else {
    return { errors: ['unsupported Watteco command 0x' + cmd.toString(16)] };
  }

  var data = {};

  if (cluster === 12 && attr === 85) {
    // Analog input: IEEE754 float32 big-endian inclination angle in degrees.
    if (bytes.length < h + 4) {
      return { errors: ['standard report missing angle value'] };
    }
    var angle = bytes2Float32(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3]);
    if (!isFinite(angle)) {
      return { errors: ['angle value is not a finite float32'] };
    }
    data.tilt = { angle: round(angle, 2) };
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. Two leading bytes (power mode + source) at h
    // and h+1, then a presence-flags byte at h+2 selecting which 2-byte
    // millivolt sources follow from h+3; emit the first present one as the
    // volts battery reading.
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var voltage;
    // bit0 external/main, bit1 rechargeable, bit2 disposable battery,
    // bit3 solar, bit4 TIC harvesting — each a 2-byte millivolt value.
    if ((flags & 0x01) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      p += 2;
    } else if ((flags & 0x02) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      p += 2;
    } else if ((flags & 0x04) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      p += 2;
    } else if ((flags & 0x08) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      p += 2;
    } else if ((flags & 0x10) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      p += 2;
    }
    if (voltage === undefined) {
      return { errors: ['power report carried no battery source'] };
    }
    data.battery = round(voltage, 3);
    return { data: data };
  }
  if (cluster === 32772 && attr === 0) {
    // LoRaWAN configuration: message type. No measurement; surface as an extra.
    if (bytes.length <= h) {
      return { errors: ['lorawan config report missing value'] };
    }
    data.messageType = bytes[h] === 1 ? 'confirmed' : 'unconfirmed';
    return { data: data };
  }

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
  };
}
