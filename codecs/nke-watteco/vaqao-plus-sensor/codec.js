// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for nke-watteco Vaqa'O+ Plus (indoor air-quality
// monitor: temperature, relative humidity, atmospheric pressure, CO2, VOC,
// luminosity and motion).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nke-watteco/vaqao-plus-sensor.js, attributed in NOTICE). Ported from
// that decoder's standard-report path (Decoder() port===125,
// decodedBatch===false); do NOT copy upstream normalizeUplink / the array
// `decoded.data` shape.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when SET the frame is a ZCL standard report; when CLEAR it is a
// Huffman-compressed "batch" frame (upstream brUncompress) which this codec
// does NOT decode and reports as an error. A standard data report carries the
// frame control (byte 0), command id (byte 1), 16-bit cluster id (bytes 2-3),
// 16-bit attribute id (bytes 4-5), a report-parameters byte (byte 6) and then
// the attribute value. Value offset is 7 for report attributes (cmd 0x0A) and
// the alarm report (cmd 0x8A); 8 for the read-attribute response (cmd 0x01,
// with a status byte at index 6). The endpoint is packed into byte 0:
//   endpoint = ((b0 & 0xE0) >> 5) | ((b0 & 0x06) << 2)
// and is used to disambiguate the dual-use concentration cluster 0x800C.
//
// Measurement-bearing clusters mapped to the shared vocabulary:
//   cluster 0x0402 (1026) temperature  -> air.temperature       (signed centi-deg C / 100)
//   cluster 0x0405 (1029) humidity     -> air.relativeHumidity  (unsigned centi-% / 100)
//   cluster 0x0403 (1027) pressure     -> air.pressure          (unsigned16 hPa, atmospheric)
//   cluster 0x800C (32780) attr 0      -> air.co2 (ppm) when endpoint != 0,
//                                          else camelCase extra `tvoc` (ppm)
//   cluster 0x0400 (1024) illuminance  -> air.lightIntensity     (unsigned16 lux)
//   cluster 0x0406 (1030) occupancy    -> action.motion.detected (bool)
//   cluster 0x0050 (80) attr 6 power   -> battery                (mV / 1000, volts)
// The lorawan-configuration cluster 0x8004 attr 0 (message type) carries no
// measurement and is surfaced as the camelCase extra `messageType`.
//
// Deliberate divergence from upstream (see AUTHORING.md "upstream is often
// wrong"): the upstream standard-report path scales pressure as raw/100, which
// can never yield a real atmospheric reading from a 16-bit value (max 655 hPa)
// and contradicts the device's own batch path (which reports ~1011 hPa). The
// 0x0403 attribute is a uint16 already expressed in hPa, so this codec emits it
// directly (atmospheric range, vocabulary bound 900-1100 hPa).

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
  // Byte 0 bit0 clear => Huffman batch frame (upstream brUncompress); unsupported.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
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
    // Atmospheric pressure: unsigned 16-bit hPa (already in vocabulary units).
    // Diverges from upstream's buggy raw/100 scaling (see header note).
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing pressure value'] };
    }
    data.air = { pressure: u16be(bytes[h], bytes[h + 1]) };
    return { data: data };
  }
  if (cluster === 32780 && attr === 0) {
    // Dual-use concentration cluster (0x800C). Endpoint 0 reports VOC; any
    // other endpoint reports CO2. Both are unsigned 16-bit ppm.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing concentration value'] };
    }
    var concentration = u16be(bytes[h], bytes[h + 1]);
    if (endpoint === 0) {
      data.tvoc = concentration;
    } else {
      data.air = { co2: concentration };
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
    // Occupancy: nonzero presence => motion detected.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing occupancy value'] };
    }
    data.action = { motion: { detected: u16be(bytes[h], bytes[h + 1]) !== 0 } };
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. Two leading bytes (power mode + source) at h
    // and h+1, then a presence-flags byte at h+2 selecting which 2-byte
    // millivolt sources follow from h+3 in source order. We surface a single
    // battery voltage, preferring the disposable/rechargeable cell over a
    // mains/external supply.
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var srcBit;
    var mainV;
    var cellV;
    // bit0 external/main, bit1 rechargeable, bit2 disposable battery,
    // bit3 solar, bit4 TIC harvesting — each a 2-byte millivolt value.
    for (srcBit = 0; srcBit < 5; srcBit++) {
      if ((flags & (1 << srcBit)) !== 0) {
        if (bytes.length < p + 2) {
          return { errors: ['power report truncated battery voltage'] };
        }
        var v = u16be(bytes[p], bytes[p + 1]) / 1000;
        p += 2;
        if (srcBit === 1 || srcBit === 2) {
          cellV = v;
        } else if (srcBit === 0) {
          mainV = v;
        }
      }
    }
    if (cellV !== undefined) {
      data.battery = round(cellV, 3);
      return { data: data };
    }
    if (mainV !== undefined) {
      data.battery = round(mainV, 3);
      return { data: data };
    }
    return { errors: ['power report carried no battery source'] };
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
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "nke-watteco";
    result.data.model = "vaqao-plus-sensor";
  }
  return result;
}
