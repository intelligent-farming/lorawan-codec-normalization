// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Vaqa'O Multi Lite (temperature,
// humidity, luminosity, atmospheric pressure, IAQ, CO2 & motion sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The
// Watteco ZCL-over-LoRa "standard report" wire format (endpoint/cluster/
// attribute framing) was understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/watteco/vaqao-lite.js,
// attributed in NOTICE). The normalization here is authored from scratch; the
// upstream normalizeUplink is NOT copied (it is array-shaped, order-stateful,
// and emits vendor variable names rather than the shared vocabulary).
//
// Scope: this codec decodes Watteco STANDARD reports (cmdID 0x0A, fPort 125).
// Watteco "batch" reports use a Huffman-compressed, bit-packed multi-sample
// format that is out of scope here; those payloads return an error rather than
// a partial/unverifiable decode.
//
// Endpoint disambiguation: the IAQ and CO2 measurements share ZCL cluster
// 0x800C; Watteco distinguishes them by endpoint (endpoint 0 = IAQ, endpoint 1
// = CO2). CO2 maps to the vocabulary key air.co2; IAQ has no vocabulary key and
// is emitted as the camelCase extra `iaq`.
//
// Battery: cluster 0x0050 attribute 0x0006 reports source voltages in volts;
// the vocabulary `battery` is volts, so the value is placed there directly.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16(hi, lo) {
  var v = u16(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  // Standard report when the LSB of the first (framing) byte is set; an even
  // first byte marks a Watteco batch report.
  if ((bytes[0] & 1) === 0) {
    return { errors: ['batch reports are not supported'] };
  }
  if (bytes.length < 8) {
    return { errors: ['payload too short for a standard report'] };
  }

  // Endpoint is encoded across two bit groups of the framing byte.
  var endpoint = ((bytes[0] & 0xe0) >> 5) | ((bytes[0] & 0x06) << 2);
  var cmdID = bytes[1];

  // Only standard attribute reports (cmdID 0x0A) carry measurements. Other
  // command IDs (e.g. read/configure responses) are device/config frames with
  // no normalized measurement.
  if (cmdID !== 0x0a) {
    return { errors: ['unsupported command id 0x' + cmdID.toString(16)] };
  }

  var clusterID = u16(bytes[2], bytes[3]);
  var attID = u16(bytes[4], bytes[5]);
  // bytes[6] is the ZCL attribute data type; the value payload begins at byte 7.
  var h = 7;

  var data = {};
  var air = {};
  var motion = {};
  var recognized = false;

  if (clusterID === 0x0402 && attID === 0x0000) {
    // Temperature (signed, hundredths of a degree Celsius).
    air.temperature = round(s16(bytes[h], bytes[h + 1]) / 100, 2);
    recognized = true;
  } else if (clusterID === 0x0405 && attID === 0x0000) {
    // Relative humidity (unsigned, hundredths of a percent).
    air.relativeHumidity = round(u16(bytes[h], bytes[h + 1]) / 100, 2);
    recognized = true;
  } else if (clusterID === 0x800c && attID === 0x0000) {
    // Concentration cluster: endpoint 1 = CO2 (ppm), endpoint 0 = IAQ index.
    var concentration = u16(bytes[h], bytes[h + 1]);
    if (endpoint === 1) {
      air.co2 = concentration;
    } else {
      data.iaq = concentration;
    }
    recognized = true;
  } else if (clusterID === 0x0400 && attID === 0x0000) {
    // Illuminance (lux).
    air.lightIntensity = u16(bytes[h], bytes[h + 1]);
    recognized = true;
  } else if (clusterID === 0x0403 && attID === 0x0000) {
    // Atmospheric pressure, already reported in hPa.
    air.pressure = s16(bytes[h], bytes[h + 1]);
    recognized = true;
  } else if (clusterID === 0x0406 && attID === 0x0000) {
    // Occupancy / motion detection (boolean).
    motion.detected = !!bytes[h];
    recognized = true;
  } else if (clusterID === 0x000f && attID === 0x0055) {
    // Binary input "case opened" / tamper -> treated as a motion event.
    motion.detected = !!bytes[h];
    recognized = true;
  } else if (clusterID === 0x0050 && attID === 0x0006) {
    // Power configuration: one or more source voltages (volts), selected by a
    // bitmap at byte 9; the present sources follow as 2-byte values from byte
    // 10, in bit order: main(0x01), rechargeable(0x02), disposable(0x04),
    // solar(0x08), TIC(0x10). Walk the bitmap in order and emit the first
    // battery source (anything other than main supply) as the battery voltage.
    var flags = bytes[h + 2];
    var idx = h + 3;
    var sources = [0x01, 0x02, 0x04, 0x08, 0x10];
    var volts;
    for (var s = 0; s < sources.length; s++) {
      if (flags & sources[s]) {
        if (sources[s] !== 0x01 && volts === undefined) {
          volts = u16(bytes[idx], bytes[idx + 1]) / 1000;
        }
        idx += 2;
      }
    }
    if (volts !== undefined) {
      data.battery = round(volts, 3);
      recognized = true;
    }
  }

  if (!recognized) {
    return {
      errors: [
        'unsupported cluster 0x' +
          clusterID.toString(16) +
          ' attribute 0x' +
          attID.toString(16)
      ]
    };
  }

  for (var k in air) {
    if (air.hasOwnProperty(k)) {
      data.air = air;
      break;
    }
  }
  for (var m in motion) {
    if (motion.hasOwnProperty(m)) {
      data.action = { motion: motion };
      break;
    }
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "vaqao-multi-lite";
  }
  return result;
}
