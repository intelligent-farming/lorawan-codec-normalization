// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Vaqa'O Multi Lite (air-quality monitor:
// temperature, humidity, CO2, IAQ, luminosity, pressure, occupancy/violation).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/vaqao-lite.js, attributed in NOTICE). The upstream
// normalizeUplink is NOT copied; normalization is authored per device.
//
// Watteco frames on fPort 125. Byte 0 carries the endpoint and a report-type
// bit; when bit 0 is SET the frame is a "standard report" (one ZCL attribute).
// This codec decodes standard reports only. The batch/datalog report format is
// a proprietary Huffman-compressed multi-sample stream that yields an array of
// readings (incompatible with the single-measurement output contract) and is
// reported as an error rather than partially decoded.
//
// Standard report layout (cmdID 0x0A "report attributes"):
//   [0] endpoint+flags   [1] cmdID   [2..3] clusterID (big-endian)
//   [4..5] attributeID   [6] report-params   [7..] attribute value (big-endian)
//
// Endpoint = ((0xE0 & b0) >> 5) | ((0x06 & b0) << 2). For cluster 0x800C the
// endpoint disambiguates IAQ (endpoint 0) from CO2 (endpoint 1).
//
// Battery (cluster 0x0050 / attr 0x0006) is reported in volts, so it maps to
// the vocabulary `battery` (V) directly. IAQ is an air-quality index the
// vocabulary does not model, so it is emitted as the camelCase extra `iaq`.

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
  if (!bytes || bytes.length < 2) {
    return { errors: ['empty or truncated payload'] };
  }

  var b0 = bytes[0];

  // Standard report requires bit 0 of byte 0 set; anything else is a batch
  // (Huffman-compressed multi-sample) report we do not decode.
  if ((b0 & 0x01) === 0) {
    return { errors: ['batch report not supported (single-measurement codec)'] };
  }

  var cmdId = bytes[1];
  // Only "report attributes" (0x0A) and its alarm variant (0x8A) carry a
  // measurement value at a fixed offset. Read responses (0x01), config reads
  // (0x07/0x09) carry device metadata, not measurements.
  if (cmdId !== 0x0a && cmdId !== 0x8a) {
    return { errors: ['unsupported ZCL command 0x' + cmdId.toString(16)] };
  }

  if (bytes.length < 8) {
    return { errors: ['truncated standard report'] };
  }

  var endpoint = ((0xe0 & b0) >> 5) | ((0x06 & b0) << 2);
  var clusterId = u16be(bytes[2], bytes[3]);
  var attrId = u16be(bytes[4], bytes[5]);
  // bytes[6] is the report-parameters byte; the attribute value starts at 7.
  var h = 7;

  var data = {};
  var air = {};
  var motion = {};
  var hasAir = false;
  var hasMotion = false;
  var recognized = false;

  if (clusterId === 0x0402 && attrId === 0x0000) {
    // Temperature, signed, /100 -> °C
    air.temperature = round(s16be(bytes[h], bytes[h + 1]) / 100, 2);
    hasAir = true;
    recognized = true;
  } else if (clusterId === 0x0405 && attrId === 0x0000) {
    // Relative humidity, unsigned, /100 -> %
    air.relativeHumidity = round(u16be(bytes[h], bytes[h + 1]) / 100, 2);
    hasAir = true;
    recognized = true;
  } else if (clusterId === 0x800c && attrId === 0x0000) {
    // Concentration index. Endpoint 1 is CO2 (ppm); endpoint 0 is the IAQ
    // air-quality index, which the vocabulary does not model (extra `iaq`).
    var conc = u16be(bytes[h], bytes[h + 1]);
    if (endpoint === 1) {
      air.co2 = conc;
      hasAir = true;
    } else {
      data.iaq = conc;
    }
    recognized = true;
  } else if (clusterId === 0x0400 && attrId === 0x0000) {
    // Illuminance, unsigned -> lux
    air.lightIntensity = u16be(bytes[h], bytes[h + 1]);
    hasAir = true;
    recognized = true;
  } else if (clusterId === 0x0403 && attrId === 0x0000) {
    // Atmospheric pressure, signed -> hPa
    air.pressure = s16be(bytes[h], bytes[h + 1]);
    hasAir = true;
    recognized = true;
  } else if (clusterId === 0x000f && attrId === 0x0055) {
    // Binary input "violation / state of the case" -> motion detected
    motion.detected = !!bytes[h];
    hasMotion = true;
    recognized = true;
  } else if (clusterId === 0x0406 && attrId === 0x0000) {
    // Occupancy -> motion detected
    motion.detected = !!bytes[h];
    hasMotion = true;
    recognized = true;
  } else if (clusterId === 0x0050 && attrId === 0x0006) {
    // Power configuration. bytes[h] type, bytes[h+1] length, bytes[h+2] is a
    // source-presence bitmap; voltages (mV, big-endian) follow in bit order:
    // bit0 main/external, bit1 rechargeable, bit2 disposable, bit3 solar,
    // bit4 TIC harvesting. Emit the first present source as volts.
    var bitmap = bytes[h + 2];
    var p = h + 3;
    var volts;
    var found = false;
    var k;
    for (k = 0; k < 5; k++) {
      if ((bitmap & (1 << k)) !== 0) {
        if (p + 1 < bytes.length && !found) {
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
  }

  if (!recognized) {
    return {
      errors: [
        'unsupported cluster 0x' +
          clusterId.toString(16) +
          ' attribute 0x' +
          attrId.toString(16)
      ]
    };
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasMotion) {
    data.action = { motion: motion };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "vaqao-plus-lite";
  }
  return result;
}
