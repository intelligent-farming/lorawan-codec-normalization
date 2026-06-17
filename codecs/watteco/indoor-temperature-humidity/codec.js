// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco TH (indoor Temperature & Humidity
// sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/indoor-temperature-humidity.js, attributed in NOTICE). Ported
// from that decoder's standard-report path (normalisation_standard, fPort 125,
// command 0x0A/0x8A/0x01) only; do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when set the frame is a ZCL standard report; when clear it is a
// Huffman-compressed "batch" frame (upstream normalisation_batch) which this
// codec does NOT decode and reports as an error. A standard data report carries
// the frame control (byte 0), command id (byte 1), 16-bit cluster id
// (bytes 2-3), 16-bit attribute id (bytes 4-5), a report-parameters byte
// (byte 6) and then the attribute value. The value offset is 7 for data and
// alarm reports (cmd 0x0A / 0x8A) and 8 for the read-attribute response
// (cmd 0x01); only the standard measurement value is decoded (any threshold/
// delta alarm metadata trailing the value is ignored).
//
// Measurement-bearing clusters mapped to the shared vocabulary:
//   cluster 0x0402 (1026) temperature -> air.temperature      (signed centi-deg C / 100)
//   cluster 0x0405 (1029) humidity    -> air.relativeHumidity (unsigned centi-% / 100)
//   cluster 0x0403 (1027) pressure    -> air.pressure         (signed 16-bit hPa, already atmospheric)
//   cluster 0x0050 (80) attr 6 power  -> battery              (mV / 1000, volts)

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
  // Byte 0 bit0 clear => Huffman batch frame (upstream normalisation_batch);
  // batch decoding is out of scope for this codec.
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
  if (cluster === 1027 && attr === 0) {
    // Atmospheric pressure: signed 16-bit hPa (already in vocabulary units).
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing pressure value'] };
    }
    data.air = { pressure: s16be(bytes[h], bytes[h + 1]) };
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. A presence-flags byte (h+2) selects which
    // 2-byte millivolt sources follow from h+3; emit the first present one
    // as the volts battery reading.
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

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
  };
}
