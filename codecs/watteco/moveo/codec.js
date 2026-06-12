// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Move'O (Temperature, Humidity,
// Occupancy & Luminosity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/moveo-lite.js, attributed in NOTICE). Do NOT copy upstream
// normalizeUplink.
//
// Watteco frames are ZCL endpoint/cluster/attribute reports on fPort 125. A
// standard data report (command 0x0A) carries the frame control (byte 0),
// command id (byte 1), 16-bit cluster id (bytes 2-3), 16-bit attribute id
// (bytes 4-5), a report-parameters byte (byte 6) and then the attribute value
// from byte 7 onward. This codec decodes only the measurement-bearing clusters
// of the Move'O and maps them to the shared vocabulary:
//   cluster 0x0402 (1026) temperature  -> air.temperature       (centi-deg C / 100)
//   cluster 0x0405 (1029) humidity     -> air.relativeHumidity  (centi-%  / 100)
//   cluster 0x0400 (1024) illuminance  -> air.lightIntensity    (lux, u16)
//   cluster 0x0406 (1030) occupancy    -> action.motion.detected (bool)
//   cluster 0x000F (15) attr 0x55 pin  -> action.motion.detected (violation flag)
//   cluster 0x0050 (80)  attr 6 power  -> battery                (mV / 1000, volts)
// Device-info frames (firmware string, dataup message type) carry no
// measurement; they are surfaced as camelCase extras with no vocabulary key.

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
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['not a standard report (frame control bit0 clear)'] };
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
    if (cluster === 1024 && attr === 0) {
      // Illuminance: unsigned 16-bit lux.
      data.air = { lightIntensity: u16be(bytes[h], bytes[h + 1]) };
      return { data: data };
    }
    if (cluster === 1030 && attr === 0) {
      // Occupancy: boolean presence.
      data.action = { motion: { detected: !!bytes[h] } };
      return { data: data };
    }
    if (cluster === 15 && attr === 85) {
      // Digital input pin state used as a violation/motion detection flag.
      data.action = { motion: { detected: !!bytes[h] } };
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
