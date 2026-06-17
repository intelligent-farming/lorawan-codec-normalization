// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Clim'O (indoor temperature & humidity
// sensor with a case-tamper input).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/climo.js, attributed in NOTICE). Ported from that decoder's
// standard-report path (module 907 normalisation_standard, port===125,
// frame-control bit0 set) only; do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the frame
// family: when SET the frame is a ZCL standard report (decoded here); when
// CLEAR it is a proprietary Huffman "batch" frame (upstream normalisation_batch)
// which this codec does NOT decode and reports as an error. A standard data
// report carries the frame control (byte 0), command id (byte 1), a 16-bit
// cluster id (bytes 2-3), a 16-bit attribute id (bytes 4-5), a report-parameters
// byte (byte 6) and then the attribute value. The value offset is 7 for data /
// alarm reports (cmd 0x0A / 0x8A) and 8 for the read-attribute response
// (cmd 0x01, whose extra status byte sits at index 6).
//
// Clim'O channels (from the upstream codec's batch descriptor + standard
// decoder) mapped to the shared vocabulary:
//   cluster 0x0402 (1026) attr 0 temperature -> air.temperature      (signed centi-deg C / 100)
//   cluster 0x0405 (1029) attr 0 humidity    -> air.relativeHumidity (unsigned centi-% / 100)
//   cluster 0x0050 (80)   attr 6 power       -> battery              (mV / 1000, volts)
// The Clim'O has no pressure, CO2 or external probe channels. Two non-vocabulary
// inputs are surfaced as camelCase extras:
//   cluster 0x000F (15) attr 0x0055 (85)   pin state   -> caseViolation (boolean tamper flag)
//   cluster 0x000F (15) attr 0x0402 (1026) pulse count -> pulseIndex    (unsigned 32-bit counter)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
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
  // Frame-control bit0 CLEAR marks a proprietary Huffman batch frame. Batch
  // decoding is out of scope for this codec.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
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

  if (cluster === 1026 && attr === 0) {
    // Temperature: signed 16-bit centi-degrees Celsius.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing temperature value'] };
    }
    data.air = { temperature: round(s16be(bytes[h], bytes[h + 1]) / 100, 2) };
    return { data: data };
  }
  if (cluster === 1029 && attr === 0) {
    // Relative humidity: unsigned 16-bit centi-percent.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing humidity value'] };
    }
    data.air = { relativeHumidity: round(u16be(bytes[h], bytes[h + 1]) / 100, 2) };
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. Two leading bytes (power mode + source) sit at
    // h and h+1, a presence-flags byte at h+2 selects which 2-byte millivolt
    // sources follow from h+3; emit the first present one as the volts battery
    // reading.
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var voltage;
    // bit0 main/external, bit1 rechargeable, bit2 disposable,
    // bit3 solar, bit4 TIC harvesting — each a 2-byte mV value.
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
  if (cluster === 15 && attr === 85) {
    // Digital input pin state used as a case-tamper / violation flag. Not a
    // vocabulary measurement; surface as a camelCase extra.
    if (bytes.length <= h) {
      return { errors: ['pin-state report missing value'] };
    }
    data.caseViolation = !!bytes[h];
    return { data: data };
  }
  if (cluster === 15 && attr === 1026) {
    // Pulse-count input: unsigned 32-bit counter. Not a vocabulary measurement;
    // surface as a camelCase extra.
    if (bytes.length < h + 4) {
      return { errors: ['pulse-count report missing value'] };
    }
    data.pulseIndex =
      bytes[h] * 16777216 + bytes[h + 1] * 65536 + bytes[h + 2] * 256 + bytes[h + 3];
    return { data: data };
  }

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
  };
}
