// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for nke-watteco Vaqa'O (indoor air-quality sensor:
// temperature, relative humidity, CO2 and VOC).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nke-watteco/vaqao-sensor.js, attributed in NOTICE). Ported from that
// decoder's standard-report path (Decoder() port===125, decodedBatch===false,
// cmdID 0x0A/0x8A/0x01); do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when set the frame is a ZCL standard report; when clear it is a
// proprietary Huffman-compressed "batch" frame (upstream brUncompress) which
// this codec does NOT decode and reports as an error. A standard data report
// carries the frame control (byte 0), command id (byte 1), 16-bit cluster id
// (bytes 2-3), 16-bit attribute id (bytes 4-5), a report-parameters byte
// (byte 6) and then the attribute value. The attribute value starts at index 7
// for data reports (cmd 0x0A / alarm 0x8A) and at index 8 for the
// read-attribute response (cmd 0x01, which carries a status byte at index 6).
//
// The ZCL endpoint is packed into byte 0:
//   endpoint = ((b0 & 0xE0) >> 5) | ((b0 & 0x06) << 2)
// and disambiguates the shared concentration cluster 0x800C: endpoint 0 is the
// VOC channel, any other endpoint is the CO2 channel (faithful to upstream).
//
// Measurement-bearing clusters mapped to the shared vocabulary:
//   cluster 0x0402 (1026) temperature -> air.temperature      (signed centi-deg C / 100)
//   cluster 0x0405 (1029) humidity    -> air.relativeHumidity (unsigned centi-% / 100)
//   cluster 0x800C (32780) endpoint!=0 CO2 -> air.co2          (unsigned16 ppm)
//   cluster 0x800C (32780) endpoint==0 VOC -> camelCase extra `voc` (unsigned16, raw)
//   cluster 0x0050 (80) attr 6 power  -> battery               (mV / 1000, volts)
// The lorawan-configuration cluster 0x8004 attr 0 (message type) carries no
// measurement and is surfaced as the camelCase extra `messageType`.

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
  // Byte 0 bit0 clear => proprietary Huffman batch frame (upstream
  // brUncompress); batch decoding is out of scope for this codec.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
  }

  // ZCL endpoint packed into byte 0 (used to split the 0x800C VOC/CO2 channel).
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
  if (cluster === 32780 && attr === 0) {
    // Shared concentration cluster: unsigned 16-bit. Endpoint 0 is the VOC
    // channel (no vocabulary key -> camelCase extra), otherwise CO2 in ppm.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing concentration value'] };
    }
    var concentration = u16be(bytes[h], bytes[h + 1]);
    if (endpoint === 0) {
      data.voc = concentration;
    } else {
      data.air = { co2: concentration };
    }
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. Two leading bytes (h, h+1) precede a
    // presence-flags byte at h+2; 2-byte millivolt sources follow from h+3 in a
    // fixed order. Upstream surfaces external mains and battery voltages; we map
    // the disposable BatteryVoltage source to the vocabulary `battery` (volts)
    // and surface the other sources as camelCase extras.
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var found = false;
    // bit0 external/main, bit2 disposable battery, bit1 rechargeable,
    // bit3 solar, bit4 TIC harvesting — each a 2-byte millivolt value, consumed
    // in this exact order (faithful to the upstream standard-report path).
    if ((flags & 0x01) && p + 1 < bytes.length) {
      data.externalPowerVoltage = round(u16be(bytes[p], bytes[p + 1]) / 1000, 3);
      p += 2;
      found = true;
    }
    if ((flags & 0x04) && p + 1 < bytes.length) {
      data.battery = round(u16be(bytes[p], bytes[p + 1]) / 1000, 3);
      p += 2;
      found = true;
    }
    if ((flags & 0x02) && p + 1 < bytes.length) {
      data.rechargeableBatteryVoltage = round(u16be(bytes[p], bytes[p + 1]) / 1000, 3);
      p += 2;
      found = true;
    }
    if ((flags & 0x08) && p + 1 < bytes.length) {
      data.solarHarvestingVoltage = round(u16be(bytes[p], bytes[p + 1]) / 1000, 3);
      p += 2;
      found = true;
    }
    if ((flags & 0x10) && p + 1 < bytes.length) {
      data.ticHarvestingVoltage = round(u16be(bytes[p], bytes[p + 1]) / 1000, 3);
      p += 2;
      found = true;
    }
    if (!found) {
      return { errors: ['power report carried no voltage source'] };
    }
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
