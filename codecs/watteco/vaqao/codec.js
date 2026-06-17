// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Vaqa'O (indoor air-quality sensor:
// temperature, relative humidity, CO2, plus an IAQ index and barometric
// pressure on some firmware/hardware variants).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/vaqao-lite.js, attributed in NOTICE). Ported from the upstream
// standard-report path (normalisation_standard) only; do NOT copy upstream
// normalizeUplink.
//
// Watteco frames are ZCL endpoint/cluster/attribute reports on fPort 125. The
// frame-control byte (byte 0) bit0 distinguishes the two frame families:
//   bit0 SET   -> standard report (this codec decodes these)
//   bit0 CLEAR -> proprietary Huffman "batch" frame (OUT OF SCOPE -> error)
// The ZCL endpoint is packed into the other bits of byte 0:
//   endpoint = ((0xE0 & b0) >> 5) | ((0x06 & b0) << 2)   (per upstream)
// A standard data report (command 0x0A at byte 1) carries a 16-bit cluster id
// (bytes 2-3), a 16-bit attribute id (bytes 4-5), a ZCL type byte (byte 6) and
// then the attribute value from byte 7 onward. This codec decodes only the
// measurement-bearing clusters of the Vaqa'O and maps them to the shared
// vocabulary:
//   cluster 0x0402 (1026) attr 0 temperature -> air.temperature      (signed centi-deg C / 100)
//   cluster 0x0405 (1029) attr 0 humidity    -> air.relativeHumidity (unsigned centi-% / 100)
//   cluster 0x0403 (1027) attr 0 pressure    -> air.pressure         (signed16 hPa, atmospheric)
//   cluster 0x800C (32780) attr 0 concentration:
//       endpoint 1 -> air.co2 (unsigned16 ppm)   [upstream "CO2"]
//       endpoint 0 -> iaq     (unsigned16 index) [upstream "IAQ"]  -- camelCase extra
//   cluster 0x0050 (80) attr 6 power           -> battery            (mV / 1000, volts)
// Upstream selects the "IAQ" vs "CO2" label for cluster 0x800C purely by the
// ZCL endpoint (concentration:["IAQ","CO2"] indexed by endpoint), so we do the
// same: only endpoint 1 is a true CO2 ppm reading; endpoint 0 is the IAQ index,
// which the vocabulary does not model and is surfaced as the `iaq` extra.
// Device-info config frames (firmware string, dataup message type) carry no
// measurement; they are surfaced as camelCase extras with no vocabulary key.
// Proprietary batch frames are reported as an error.

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

  var endpoint = ((bytes[0] & 0xe0) >> 5) | ((bytes[0] & 0x06) << 2);
  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  var data = {};

  // Standard data report (command 0x0A): attribute value starts at byte 7.
  if (cmd === 0x0a) {
    var h = 7;
    if (bytes.length <= 7) {
      return { errors: ['standard report missing attribute value'] };
    }

    if (cluster === 1026 && attr === 0) {
      // Temperature: signed 16-bit centi-degrees Celsius.
      data.air = { temperature: round(s16be(bytes[h], bytes[h + 1]) / 100, 2) };
      return { data: data };
    }
    if (cluster === 1029 && attr === 0) {
      // Relative humidity: unsigned 16-bit centi-percent.
      data.air = { relativeHumidity: round(u16be(bytes[h], bytes[h + 1]) / 100, 2) };
      return { data: data };
    }
    if (cluster === 1027 && attr === 0) {
      // Barometric pressure: signed 16-bit hPa (no scaling). The Vaqa'O reports
      // absolute atmospheric pressure (vocabulary bound 900-1100 hPa).
      data.air = { pressure: s16be(bytes[h], bytes[h + 1]) };
      return { data: data };
    }
    if (cluster === 32780 && attr === 0) {
      // Generic concentration cluster (0x800C), unsigned 16-bit. The endpoint
      // disambiguates: endpoint 1 is the CO2 ppm reading; endpoint 0 is the IAQ
      // index. (Upstream picks the label from a per-endpoint table.)
      var concentration = u16be(bytes[h], bytes[h + 1]);
      if (endpoint === 1) {
        data.air = { co2: concentration };
      } else {
        data.iaq = concentration;
      }
      return { data: data };
    }
    if (cluster === 80 && attr === 6) {
      // Power configuration report. Two leading bytes (power mode + source) at
      // h and h+1, then a presence-flags byte at h+2 selecting which 2-byte
      // millivolt sources follow from h+3; emit the first present one as the
      // volts battery reading.
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

    return {
      errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
    };
  }

  // Config-style command (0x01): device-info frames. These carry no
  // measurement; surface known ones as camelCase extras. Value starts at byte 8
  // (the standard report header plus a 2-byte status field).
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
