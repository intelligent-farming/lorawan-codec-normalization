// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Hygro Temp'O remote (indoor
// temperature + relative humidity measured through a remote IP67/IP68 probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/hygrotempo-remote.js, attributed in NOTICE). Ported from that
// decoder's standard-report path (port===125, non-batch frame) only; do NOT
// copy upstream normalizeUplink / its `samples` output.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when SET the frame is a ZCL standard report; when CLEAR it is a
// proprietary Huffman-compressed "batch" frame (upstream brUncompress) which
// this codec does NOT decode and reports as an error. A standard data report
// carries the frame control (byte 0), command id (byte 1), 16-bit cluster id
// (bytes 2-3), 16-bit attribute id (bytes 4-5), a report-parameters byte
// (byte 6) and then the attribute value. The attribute value offset is 7 for
// data / alarm reports (cmd 0x0A / 0x8A) and 8 for the read-attribute response
// (cmd 0x01, which inserts a status byte at byte 6).
//
// Despite the "remote" name, this device exposes a single remote probe and
// reports it on the ordinary temperature/humidity clusters; there is no
// separate internal/external temperature endpoint. Measurement-bearing
// clusters mapped to the shared vocabulary:
//   cluster 0x0402 (1026) temperature -> air.temperature      (signed centi-deg C / 100)
//   cluster 0x0405 (1029) humidity    -> air.relativeHumidity (unsigned centi-% / 100)
//   cluster 0x0050 (80) attr 6 power  -> battery              (mV / 1000, volts)
// Non-climate clusters this hardware can also report (case-tamper violation on
// cluster 0x000F attr 0x0055, pulse index on cluster 0x000F attr 0x0402) carry
// no climate measurement and are reported as unrecognized.

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 125) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 125)'] };
  }
  if (!bytes || bytes.length < 6) {
    return { errors: ['payload too short for a Watteco ZCL report'] };
  }
  // Byte 0 bit0 clear => proprietary Huffman batch frame (upstream
  // brUncompress); batch decoding is out of scope for this codec.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
  }

  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  // Standard data report (cmd 0x0A) or alarm report (cmd 0x8A): value at index
  // 7. Read-attribute response (cmd 0x01) inserts a status byte at index 6, so
  // its value starts at index 8.
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
    // Power configuration report. A presence-flags byte (h+2) selects which
    // 2-byte millivolt sources follow from h+3; emit the first present one as
    // the volts battery reading.
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var voltage;
    // bit0 main/external, bit1 rechargeable, bit2 disposable, bit3 solar,
    // bit4 TIC harvesting — each a 2-byte millivolt value.
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "hygrotempo-remote";
  }
  return result;
}
