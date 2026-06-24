// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for nke-watteco Lev'O+ (submersible liquid-level /
// hydrostatic-pressure probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nke-watteco/levo-plus-sensor.js, attributed in NOTICE). Ported from
// that decoder's standard-report path (Decoder() port===125,
// decodedBatch===false); do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when CLEAR the frame is a Huffman-compressed "batch" frame (upstream
// brUncompress) which this codec does NOT decode and reports as an error; when
// SET the frame is a ZCL standard report. A standard data report carries the
// frame control (byte 0), command id (byte 1), 16-bit cluster id (bytes 2-3),
// 16-bit attribute id (bytes 4-5) and then the attribute value at index 7 for
// data/alarm reports (cmd 0x0A / 0x8A) and index 8 for the read-attribute
// response (cmd 0x01, which carries a status byte at index 6).
//
// Byte 0 also encodes the ZCL endpoint:
//   endpoint = ((b0 & 0xE0) >> 5) | ((b0 & 0x06) << 2)
// The probe exposes its single analog reading on two endpoints of the analog
// input cluster (0x000C attr 0x0055, an IEEE754 float32 big-endian carrying the
// 4-20 mA loop current in mA):
//   endpoint 0 -> hydrostatic pressure. Upstream transfer function:
//       deltaPressure_Pa = (mA * 0.01875 - 0.075) * 100000
//     mapped to water.pressure (kPa) = deltaPressure_Pa / 1000.
//   endpoint 1 -> fluid level. Upstream: level_m = deltaPressure_Pa / (9.81*997)
//     (hydrostatic head, rho = 997 kg/m^3, g = 9.81 m/s^2), mapped to
//     water.level (m).
//
// Faithful-port note: upstream computes FluidLevel from a module-global
// `DeltaPressure` left over from a previous endpoint-0 frame (stateful, and
// relies on the probe reporting the same loop current on both endpoints). A
// console-safe codec cannot carry state between invocations, so this port
// recomputes the pressure from the endpoint-1 frame's OWN float bytes and then
// applies the same /(9.81*997) head conversion. For the normal device behaviour
// (both endpoints report the same loop current) this reproduces upstream's
// level exactly.
//
// Other measurement-bearing clusters:
//   cluster 0x0050 (80) attr 0x0006 (6) node power descriptor -> battery (mV /
//       1000, volts). A flags byte selects which 2-byte millivolt sources
//       follow; the first present source (external/main, rechargeable,
//       disposable, solar, TIC) is emitted as the volts battery reading,
//       mirroring the nke-watteco skydome / TH / Atm'O codecs.
//   cluster 0x8004 (32772) attr 0x0000 (0) lorawan message type -> camelCase
//       extra `messageType`.

var RHO = 997; // water density kg/m^3 (upstream constant)
var G = 9.81; // gravitational acceleration m/s^2 (upstream constant)

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

// 4-20 mA loop current (mA) -> hydrostatic pressure in pascals.
function maToPressurePa(ma) {
  return (ma * 0.01875 - 0.075) * 100000;
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

  var endpoint = ((bytes[0] & 0xe0) >> 5) | ((bytes[0] & 0x06) << 2);
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
    // Analog input: IEEE754 float32 big-endian 4-20 mA loop current (mA).
    if (bytes.length < h + 4) {
      return { errors: ['analog report missing 4-20 mA value'] };
    }
    var ma = bytes2Float32(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3]);
    if (!isFinite(ma)) {
      return { errors: ['4-20 mA value is not a finite float32'] };
    }
    var pressurePa = maToPressurePa(ma);
    if (endpoint === 1) {
      // Endpoint 1: fluid level (hydrostatic head, m).
      data.water = { level: round(pressurePa / (RHO * G), 4) };
    } else {
      // Endpoint 0 (default): hydrostatic pressure (Pa -> kPa).
      data.water = { pressure: round(pressurePa / 1000, 3) };
    }
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Node power descriptor. Two leading bytes (power mode + source) at h and
    // h+1, then a presence-flags byte at h+2 selecting which 2-byte millivolt
    // sources follow from h+3; emit the first present one as the volts battery
    // reading.
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
