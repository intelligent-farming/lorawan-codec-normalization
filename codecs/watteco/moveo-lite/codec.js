// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Move'O Lite (Temperature, Humidity,
// Occupancy & Luminosity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa: a ZCL header followed by cluster/attribute
// reports) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/watteco/moveo-lite.js, attributed in
// NOTICE). The upstream decoder ships a full Huffman batch decompressor and an
// every-Watteco-cluster dispatch; here we decode only the standard single
// cluster/attribute reports this product emits and map them to the shared
// vocabulary. Upstream normalizeUplink is NOT copied.
//
// Header (uplink fPort 125, "standard" report):
//   e[0] : endpoint/report bits (low bit set => standard report; clear => batch)
//   e[1] : ZCL command id  (0x0A = report, 0x01 = read-attr / config report)
//   e[2..3] : cluster id (big-endian)
//   e[4..5] : attribute id (big-endian)
//   e[6] : ZCL attribute data-type byte (report commands)
//   data starts at index 7 for command 0x0A, index 8 for command 0x01.
//
// Clusters used by this product:
//   0x0402 (1026) att0 : temperature, signed int16, value/100 °C  -> air.temperature
//   0x0405 (1029) att0 : relative humidity, uint16, value/100 %   -> air.relativeHumidity
//   0x0400 (1024) att0 : illuminance, uint16 lux                  -> air.lightIntensity
//   0x0406 (1030) att0 : occupancy, boolean                       -> action.motion.detected
//   0x000F (15)   att85: digital-input pin state (violation), bool-> action.motion.detected
//   0x0050 (80)   att6 : power descriptor (battery voltages, mV)  -> battery (V)
//   0x0000 (0)    att2 : firmware version                         -> firmware (extra)
//   0x8004 (32772)att0 : data-up config (message type)            -> messageType (extra)

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

  if (!bytes || bytes.length < 4) {
    return { errors: ['payload too short'] };
  }
  if (input.fPort !== 125) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 125)'] };
  }
  // Low bit of the first byte set => standard report; clear => batch/other.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['unsupported report type (not a standard report)'] };
  }

  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);

  var h;
  if (cmd === 0x0a || cmd === 0x8a) {
    h = 7;
  } else if (cmd === 0x01) {
    h = 8;
  } else {
    return { errors: ['unsupported ZCL command 0x' + cmd.toString(16)] };
  }

  if (bytes.length < 6) {
    return { errors: ['payload too short for attribute report'] };
  }
  var attr = u16be(bytes[4], bytes[5]);

  var data = {};
  var air = {};
  var motion = {};
  var recognized = false;

  if (cluster === 1026 && attr === 0) {
    // Temperature: signed int16, hundredths of a degree Celsius.
    air.temperature = round(s16be(bytes[h], bytes[h + 1]) / 100, 2);
    recognized = true;
  } else if (cluster === 1029 && attr === 0) {
    // Relative humidity: uint16, hundredths of a percent.
    air.relativeHumidity = round(u16be(bytes[h], bytes[h + 1]) / 100, 2);
    recognized = true;
  } else if (cluster === 1024 && attr === 0) {
    // Illuminance: uint16 lux.
    air.lightIntensity = u16be(bytes[h], bytes[h + 1]);
    recognized = true;
  } else if (cluster === 1030 && attr === 0) {
    // Occupancy: boolean.
    motion.detected = !!bytes[h];
    recognized = true;
  } else if (cluster === 15 && attr === 85) {
    // Digital-input pin state ("violation detection"): boolean presence event.
    motion.detected = !!bytes[h];
    recognized = true;
  } else if (cluster === 80 && attr === 6) {
    // Power descriptor: a byte string. bytes[h] = string length,
    // bytes[h+2] = bitmap of which voltage fields follow (mV, big-endian),
    // values start at bytes[h+3] in bitmap order.
    var bitmap = bytes[h + 2];
    var p = h + 3;
    var volts;
    var found = false;
    var bit;
    for (bit = 0; bit < 5; bit++) {
      if ((bitmap & (1 << bit)) !== 0) {
        if (!found) {
          // First present source is the battery in service for this product
          // (main/rechargeable/disposable/solar all reported in mV).
          volts = round(u16be(bytes[p], bytes[p + 1]) / 1000, 3);
          found = true;
        }
        p += 2;
      }
    }
    if (found) {
      data.battery = volts;
      recognized = true;
    }
  } else if (cluster === 0 && attr === 2) {
    // Firmware version string: major.minor.revision.build.
    var fw = '' + bytes[h] + '.' + bytes[h + 1] + '.' + bytes[h + 2];
    var build = bytes[h + 3] * 65536 + bytes[h + 4] * 256 + bytes[h + 5];
    data.firmware = fw + '.' + build;
    recognized = true;
  } else if (cluster === 32772 && attr === 0) {
    // Data-up configuration: message type.
    data.messageType = bytes[h] === 1 ? 'confirmed' : 'unconfirmed';
    recognized = true;
  }

  if (!recognized) {
    return {
      errors: [
        'unsupported cluster/attribute 0x' +
          cluster.toString(16) +
          '/0x' +
          attr.toString(16)
      ]
    };
  }

  if (air.temperature !== undefined ||
      air.relativeHumidity !== undefined ||
      air.lightIntensity !== undefined) {
    data.air = air;
  }
  if (motion.detected !== undefined) {
    data.action = { motion: motion };
  }
  if (typeof input.recvTime === 'string' && input.recvTime.length > 0) {
    data.time = input.recvTime;
  }

  return { data: data };
}
