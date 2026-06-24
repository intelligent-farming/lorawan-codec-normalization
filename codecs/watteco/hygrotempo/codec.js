// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Hygro Temp'O (indoor temperature +
// relative humidity sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") ported/normalized from the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/hygrotempo.js, attributed in NOTICE). Ported from that
// decoder's standard-report path (normalisation_standard, port 125, non-batch)
// only; do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when SET the frame is a ZCL standard report (decoded here); when CLEAR
// it is a proprietary Huffman-compressed "batch" frame (upstream brUncompress /
// normalisation_batch) which this codec does NOT decode and reports as an
// error. A standard report carries the frame control (byte 0), command id
// (byte 1), 16-bit cluster id (bytes 2-3), 16-bit attribute id (bytes 4-5), a
// report-parameters byte (byte 6) and then the attribute value. Per the
// upstream header dispatch (m = e[1]): the attribute value offset is 7 for a
// data report (cmd 0x0A) or alarm report (cmd 0x8A), and 8 for the
// read-attribute response (cmd 0x01, which carries a status byte at index 6 and
// a type byte at index 7). Commands 0x07/0x09 are configuration-response frames
// that carry no measurement.
//
// Measurement-bearing clusters of the Hygro Temp'O mapped to the shared
// vocabulary (units normalized per the upstream value decode):
//   cluster 0x0402 (1026) attr 0 temperature -> air.temperature      (UintToInt signed centi-deg C / 100)
//   cluster 0x0405 (1029) attr 0 humidity    -> air.relativeHumidity (unsigned centi-% / 100)
//   cluster 0x0050 (80)   attr 6 power        -> battery              (mV / 1000, volts)
// Non-climate clusters this device can also emit (case-state violation flag on
// cluster 0x000F, pulse index, config frames) carry no climate measurement and
// are reported as unrecognized.

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
  // normalisation_batch / brUncompress); not supported by this codec.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
  }

  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  // Standard data report (cmd 0x0A) or alarm report (cmd 0x8A): value at index
  // 7. Read-attribute response (cmd 0x01): a status byte sits at index 6 and a
  // type byte at index 7, so the value begins at index 8. Configuration
  // responses (cmd 0x07 / 0x09) carry only a header and no measurement.
  var h;
  if (cmd === 0x0a || cmd === 0x8a) {
    h = 7;
  } else if (cmd === 0x01) {
    h = 8;
  } else if (cmd === 0x07 || cmd === 0x09) {
    return { errors: ['Watteco configuration response carries no measurement'] };
  } else {
    return { errors: ['unsupported Watteco command 0x' + cmd.toString(16)] };
  }

  var data = {};

  if (cluster === 1026 && attr === 0) {
    // Temperature: signed 16-bit centi-degrees Celsius (upstream UintToInt/100).
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing temperature value'] };
    }
    data.air = { temperature: round(s16be(bytes[h], bytes[h + 1]) / 100, 2) };
    return { data: data };
  }
  if (cluster === 1029 && attr === 0) {
    // Relative humidity: unsigned 16-bit centi-percent (upstream value/100).
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing humidity value'] };
    }
    data.air = { relativeHumidity: round(u16be(bytes[h], bytes[h + 1]) / 100, 2) };
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. A presence-flags byte (h+2) selects which
    // 2-byte millivolt sources follow from h+3; emit the first present one as
    // the volts battery reading (upstream divides each source by 1e3).
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var voltage;
    // bit0 main/external, bit1 rechargeable, bit2 disposable battery,
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

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "hygrotempo";
  }
  return result;
}
