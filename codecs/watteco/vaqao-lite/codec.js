// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco VAQ'AO Lite (indoor air-quality sensor:
// temperature, relative humidity, CO2, IAQ, plus optional illuminance,
// occupancy and case-tamper reporting).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/vaqao-lite.js, attributed in NOTICE). Ported from that
// decoder's standard-report path (normalisation_standard, fPort 125, frame
// control bit0 SET); do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the frame
// family: SET -> ZCL standard report (decoded here); CLEAR -> proprietary
// Huffman-compressed "batch" frame (upstream brUncompress) which this codec
// does NOT decode and reports as an error. A standard data report carries the
// frame control (byte 0), command id (byte 1), 16-bit cluster id (bytes 2-3),
// 16-bit attribute id (bytes 4-5), a report-parameters byte (byte 6) and then
// the attribute value. Value offset is 7 for data/alarm reports (cmd 0x0A /
// 0x8A) and 8 for the read-attribute response (cmd 0x01).
//
// Byte 0 also encodes the ZCL endpoint:
//   endpoint = ((byte0 & 0xE0) >> 5) | ((byte0 & 0x06) << 2)
// The VAQ'AO Lite reuses cluster 0x800C for two distinct measurements,
// disambiguated by endpoint: endpoint 0 carries IAQ (an index, surfaced as the
// camelCase extra `iaq`); endpoint 1 carries CO2 in ppm (-> air.co2).
//
// Measurement-bearing clusters mapped to the shared vocabulary:
//   cluster 0x0402 (1026) attr 0 temperature -> air.temperature      (signed centi-deg C / 100)
//   cluster 0x0405 (1029) attr 0 humidity    -> air.relativeHumidity (unsigned centi-% / 100)
//   cluster 0x0403 (1027) attr 0 pressure    -> air.pressure         (signed 16-bit hPa, atmospheric)
//   cluster 0x800C (32780) attr 0 ep1 CO2    -> air.co2              (unsigned 16-bit ppm)
//   cluster 0x800C (32780) attr 0 ep0 IAQ    -> iaq (extra)          (unsigned 16-bit index)
//   cluster 0x0400 (1024) attr 0 illuminance -> air.lightIntensity   (unsigned 16-bit lux)
//   cluster 0x0050 (80) attr 6 power         -> battery              (mV / 1000, volts)
// Non-measurement clusters surfaced as camelCase extras with no vocabulary key:
//   cluster 0x0406 (1030) attr 0 occupancy        -> occupancy (boolean)
//   cluster 0x000F (15) attr 85 case violation    -> violationDetection (boolean)
//   cluster 0x0000 (0) attr 2 firmware            -> firmware (string)
//   cluster 0x8004 (32772) attr 0 message type    -> messageType (string)

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
  // Byte 0 bit0 CLEAR marks a proprietary Huffman batch frame. Batch decoding
  // is out of scope for this codec.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
  }

  // ZCL endpoint from the frame-control byte.
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
  if (cluster === 32780 && attr === 0) {
    // Cluster 0x800C carries either CO2 (endpoint 1) or the IAQ index
    // (endpoint 0) as an unsigned 16-bit value.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing air-quality value'] };
    }
    var aqValue = u16be(bytes[h], bytes[h + 1]);
    if (endpoint === 1) {
      data.air = { co2: aqValue };
    } else {
      // IAQ is a unitless index; the vocabulary does not model it -> extra.
      data.iaq = aqValue;
    }
    return { data: data };
  }
  if (cluster === 1024 && attr === 0) {
    // Illuminance: unsigned 16-bit lux.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing illuminance value'] };
    }
    data.air = { lightIntensity: u16be(bytes[h], bytes[h + 1]) };
    return { data: data };
  }
  if (cluster === 1030 && attr === 0) {
    // Occupancy: boolean. No vocabulary key -> camelCase extra.
    if (bytes.length <= h) {
      return { errors: ['standard report missing occupancy value'] };
    }
    data.occupancy = !!bytes[h];
    return { data: data };
  }
  if (cluster === 15 && attr === 85) {
    // Case-tamper / violation pin state: boolean. No vocabulary key -> extra.
    if (bytes.length <= h) {
      return { errors: ['standard report missing violation value'] };
    }
    data.violationDetection = !!bytes[h];
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

  // Config-style command (cmd 0x01): device-info / lorawan-config frames carry
  // no measurement; surface known ones as camelCase extras.
  if (cmd === 0x01) {
    if (cluster === 0 && attr === 2 && bytes.length >= h + 6) {
      // Firmware version: three decimal octets then a 24-bit build number.
      var build = bytes[h + 3] * 65536 + bytes[h + 4] * 256 + bytes[h + 5];
      data.firmware =
        String(bytes[h]) +
        '.' +
        String(bytes[h + 1]) +
        '.' +
        String(bytes[h + 2]) +
        '.' +
        String(build);
      return { data: data };
    }
    if (cluster === 32772 && attr === 0 && bytes.length > h) {
      data.messageType = bytes[h] === 1 ? 'confirmed' : 'unconfirmed';
      return { data: data };
    }
  }

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
  };
}
