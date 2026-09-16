// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Lev'O+ (pressure probe), read here as a
// generic 4-20 mA analog-interface transmitter.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/levo.js, attributed in NOTICE) and to the shared Watteco
// standard-report path already ported for vendor/watteco/tempo. Only the
// standard-report path is ported (fPort 125, command 0x0A/0x8A/0x01); the
// Huffman-compressed "batch" frame is NOT decoded, and upstream normalizeUplink
// is NOT copied.
//
// Lev'O+ measures a 4-20 mA loop from an attached pressure probe. Because the
// physical pressure value depends on the external probe's range (not on this
// transmitter), we normalize the raw loop reading to the generic analog
// interface vocabulary rather than to a pressure key.
//
// A standard data report carries the frame control (byte 0), command id
// (byte 1), 16-bit cluster id (bytes 2-3), 16-bit attribute id (bytes 4-5), a
// ZCL data-type byte (byte 6) and then the attribute value. Value offset is 7
// for data/alarm reports (cmd 0x0A / 0x8A) and 8 for the read-attribute
// response (cmd 0x01).
//
// Measurement mapping:
//   cluster 12 (0x000C) attr 85 (0x0055) analog input -> analog.current (mA),
//       IEEE-754 big-endian float32 (the "4-20_mA" tag in the upstream driver)
//   cluster 80 (0x0050) attr 6 power configuration     -> battery (V)
// Firmware/config clusters (e.g. attr id 2, cluster 0x8004) carry no
// measurement and are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// IEEE-754 single-precision, big-endian byte order.
function float32be(b0, b1, b2, b3) {
  var bits = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  var sign = (bits >>> 31) === 0 ? 1.0 : -1.0;
  var exp = (bits >>> 23) & 0xff;
  var mant = bits & 0x7fffff;
  if (exp === 0xff) {
    return mant === 0 ? sign * Infinity : NaN;
  }
  var m;
  var e;
  if (exp === 0) {
    e = -126;
    m = mant / 0x800000;
  } else {
    e = exp - 127;
    m = 1 + mant / 0x800000;
  }
  return sign * m * Math.pow(2, e);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 125) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 125)'] };
  }
  if (!bytes || bytes.length < 6) {
    return { errors: ['payload too short for a Watteco ZCL report'] };
  }
  // Byte 0 bit0 clear => Huffman batch frame; unsupported.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
  }

  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  var h;
  if (cmd === 0x0a || cmd === 0x8a) {
    h = 7;
  } else if (cmd === 0x01) {
    h = 8;
  } else {
    return { errors: ['unsupported Watteco command 0x' + cmd.toString(16)] };
  }

  var data = {};

  // Analog input: 4-20 mA loop current as a big-endian float32.
  if (cluster === 12 && attr === 85) {
    if (bytes.length < h + 4) {
      return { errors: ['analog report missing 4-byte value'] };
    }
    data.analog = { current: round(float32be(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3]), 3) };
    return { data: data };
  }

  // Power configuration report -> battery volts. Flags byte at h+2 selects
  // which 2-byte millivolt sources follow (bit0 external, bit1 rechargeable,
  // bit2 disposable, bit3 solar, bit4 TIC), in wire order.
  if (cluster === 80 && attr === 6) {
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var voltage;
    var bit;
    for (bit = 0; bit < 5; bit++) {
      if ((flags & (1 << bit)) && p + 1 < bytes.length) {
        voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
        break;
      }
    }
    if (voltage === undefined) {
      return { errors: ['power report carried no battery source'] };
    }
    data.battery = round(voltage, 3);
    return { data: data };
  }

  return { errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "watteco", model: "levo" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "levo";
  }
  return result;
}
