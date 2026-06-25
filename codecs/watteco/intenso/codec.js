// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Intens-O (RMS current sensor): analog-input float32 -> power.current.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report" and "batch report")
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/watteco/inclino.js, attributed in
// NOTICE). Do NOT copy upstream normalizeUplink.
//
// Watteco frames are ZCL endpoint/cluster/attribute reports on fPort 125. A
// standard data report (command 0x0A) carries the frame control (byte 0),
// command id (byte 1), 16-bit cluster id (bytes 2-3), 16-bit attribute id
// (bytes 4-5), a report-parameters byte (byte 6) and then the attribute value
// from byte 7 onward. This codec decodes only the measurement-bearing clusters
// of the Inclino and maps them to the shared vocabulary:
//   cluster 0x000C (12) attr 0x55 analog -> tilt.angle  (IEEE754 float32, degrees)
//   cluster 0x0050 (80) attr 6 power     -> battery     (mV / 1000, volts)
// Device-info frames (firmware string, dataup message type) carry no
// measurement; they are surfaced as camelCase extras with no vocabulary key.
//
// The angle attribute is an IEEE754 single-precision float. In a standard
// report it is the inclination in degrees as-is (e.g. 0x41500000 = 13.0 deg).
// The device can also batch-report a compressed time series of accelerometer
// magnitude samples ("ACCmg", milli-g, divider 1) and inclination samples
// ("Deg", float32 scaled by 1000). Batch frames (frame control bit0 clear)
// require the per-device Huffman/coding tables and the two prior reference
// frames to decompress; that state is not available to a stateless console
// codec, so batch frames are reported as an error rather than mis-decoded.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32be(b0, b1, b2, b3) {
  // Avoid sign issues from << on the high byte; build with multiplication.
  return ((b0 & 0xff) * 16777216) + ((b1 & 0xff) << 16) + ((b2 & 0xff) << 8) + (b3 & 0xff);
}

// IEEE754 single-precision float from a 32-bit unsigned integer.
function f32(bits) {
  var sign = (bits & 0x80000000) ? -1 : 1;
  var exp = (bits >> 23) & 0xff;
  var frac = bits & 0x7fffff;
  if (exp === 0xff) {
    return sign * (frac ? NaN : Infinity);
  }
  var mant;
  if (exp === 0) {
    if (frac === 0) {
      return 0;
    }
    exp = -126;
    mant = frac / 8388608;
  } else {
    exp = exp - 127;
    mant = (frac | 0x800000) / 8388608;
  }
  return sign * mant * Math.pow(2, exp);
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
  if ((bytes[0] & 0x01) === 0) {
    return {
      errors: [
        'batch report not supported (requires per-device coding tables and prior frames)',
      ],
    };
  }

  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  var data = {};

  // Standard data report: attribute value starts at byte index 7.
  if (cmd === 0x0a) {
    var h = 7;
    if (bytes.length <= 7) {
      return { errors: ['standard report missing attribute value'] };
    }

    if (cluster === 12 && attr === 85) {
      // Analog input present value (RMS current): IEEE754 float32, amperes.
      var curBits = u32be(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3]);
      var cur = f32(curBits);
      if (!isFinite(cur)) {
        return { errors: ['current attribute decoded to a non-finite value'] };
      }
      data.power = { current: round(cur, 3) };
      return { data: data };
    }
    if (cluster === 80 && attr === 6) {
      // Power configuration report. A presence-flags byte (h+2) selects which
      // 2-byte millivolt sources follow from h+3; emit the first present one
      // as the volts battery reading.
      var flags = bytes[h + 2];
      var p = h + 3;
      var voltage;
      // bit0 main/external, bit1 rechargeable, bit2 disposable,
      // bit3 solar, bit4 TIC harvesting — each a 2-byte mV value.
      if ((flags & 0x01) && p + 1 < bytes.length) {
        voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      } else if ((flags & 0x02) && p + 1 < bytes.length) {
        voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      } else if ((flags & 0x04) && p + 1 < bytes.length) {
        voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      } else if ((flags & 0x08) && p + 1 < bytes.length) {
        voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      } else if ((flags & 0x10) && p + 1 < bytes.length) {
        voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
      }
      if (voltage === undefined) {
        return { errors: ['power report carried no battery source'] };
      }
      data.battery = round(voltage, 3);
      return { data: data };
    }

    return {
      errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
    };
  }

  // Config-style command (0x01): device-info frames. These carry no
  // measurement; surface known ones as camelCase extras.
  if (cmd === 0x01) {
    var hi = 8;
    if (cluster === 0 && attr === 2 && bytes.length >= hi + 6) {
      // Firmware version: three decimal octets then a 24-bit build number.
      var build = bytes[hi + 3] * 65536 + bytes[hi + 4] * 256 + bytes[hi + 5];
      data.firmware =
        String(bytes[hi]) +
        '.' +
        String(bytes[hi + 1]) +
        '.' +
        String(bytes[hi + 2]) +
        '.' +
        String(build);
      return { data: data };
    }
    if (cluster === 32772 && attr === 0 && bytes.length > hi) {
      data.messageType = bytes[hi] === 1 ? 'confirmed' : 'unconfirmed';
      return { data: data };
    }
    return {
      errors: ['unrecognized Watteco config cluster ' + cluster + ' attribute ' + attr],
    };
  }

  return { errors: ['unsupported Watteco command 0x' + cmd.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "intenso";
  }
  return result;
}
