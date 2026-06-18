// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-THX (Temperature & Humidity Sensor).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream file is ATIM's generic "ACW" decoder shared across the
// whole product line; the source of truth for the THX wire format is its
// measurement-frame path (`getFrameType` -> "Trame de mesure"/"Trame de test"
// -> `decodeFrame`) plus the life frame ("Trame de vie") and error frame
// ("Trame d'erreur"). The frame-type nibble logic, the channel/type TLV walk
// (type 0x08 = temperature, 0x09 = humidity, each big-endian signed centi-units
// with -327.68 / 327.68 as the sensor-fault sentinel), and the life-frame
// battery voltage (tensionv = raw / 1000) are ported faithfully from upstream.
//
// Mapping into the normalized vocabulary:
//   temperature channel -> air.temperature   (degrees C)
//   humidity channel    -> air.relativeHumidity (%)
//   life-frame tensionv -> battery            (V; tensionv is the device's
//                          battery/pile voltage, so it maps to the volts key)
//   life-frame tensionc -> supplyVoltage      (V; secondary supply rail, no
//                          vocabulary key -> camelCase extra)
//   frame type          -> frameType          (camelCase extra)
//   measurement channel -> channel            (camelCase extra; the THX voie,
//                          0 for the internal sensor)
// Sensor-fault sentinels and non-measurement/non-life frames yield errors.
//
// Scope note: ATIM measurement frames may carry a history of several samples
// (echan x historique) and an optional embedded timestamp/period. Deriving an
// RFC3339 time for each prior sample requires both the absolute timestamp frame
// header and the sampling period, which the canonical THX uplink does not carry
// reliably; rather than emit a `history` array without trustworthy `time`
// values, this codec normalizes the most recent (index 0) sample of the frame.

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

// Minimal-width MSB-first 4-bit string for a nibble, matching the upstream
// frame-type bit indexing (bin1[0] = bit 3 / value 8, bin1[2] = bit 1 / value
// 2). Upstream left-pads to width 4.
function nibbleBits(n) {
  var s = (n & 0x0f).toString(2);
  while (s.length < 4) {
    s = '0' + s;
  }
  return s;
}

// Classify the frame from its first two nibbles, mirroring upstream
// getFrameType for the cases the THX emits.
function frameTypeOf(bytes) {
  var oct1 = (bytes[0] >> 4) & 0x0f; // high nibble of byte 0
  var oct2 = bytes[0] & 0x0f; // low nibble of byte 0
  var bin1 = nibbleBits(oct1);

  if (bin1[0] === '0') {
    return 'legacy';
  }
  if (bin1[2] === '1') {
    return 'measure';
  }
  if (oct2 === 0x1) {
    return 'life';
  }
  if (oct2 === 0x5) {
    return 'test';
  }
  if (oct2 === 0x2) {
    return 'networkTest';
  }
  if (oct2 === 0xd) {
    return 'alert';
  }
  if (oct2 === 0xe) {
    return 'error';
  }
  if (oct2 === 0xf) {
    return 'specific';
  }
  if (oct2 === 0x9) {
    return 'measureExtended';
  }
  return 'unknown';
}

var FRAME_TYPE_LABEL = {
  measure: 'measurement',
  test: 'test',
  life: 'life',
  networkTest: 'networkTest',
  alert: 'alert',
  error: 'error',
  specific: 'specific',
  measureExtended: 'measurementExtended',
  legacy: 'legacy',
  unknown: 'unknown'
};

// Walk the channel/type TLV stream of a measurement/test frame, reading only
// the first (most recent) sample of each temperature (0x08) and humidity (0x09)
// channel. start is the index of the first TLV byte.
function decodeMeasurement(bytes, start, isTest) {
  var air = {};
  var channel = null;
  var sawTempOrHum = false;
  var fault = false;

  var i = start;
  while (i < bytes.length) {
    var raw = bytes[i];
    var type = raw & 0x0f;
    var voie = 0;
    if (type !== raw) {
      // High nibble carries the voie (channel) index in measurement frames.
      var v = raw & 0xf0;
      if (v === 0x10) {
        voie = 1;
      } else if (v === 0x20) {
        voie = 2;
      } else if (v === 0x30) {
        voie = 3;
      }
    }

    if (type === 0x08) {
      // temperature: 2-byte big-endian signed, centi-degrees.
      var traw = s16be(bytes[i + 1], bytes[i + 2]);
      if (traw / 100 === -327.68) {
        fault = true;
      } else if (air.temperature === undefined) {
        air.temperature = round(traw / 100, 2);
        channel = voie;
      }
      sawTempOrHum = true;
      i += 3;
    } else if (type === 0x09) {
      // humidity: 2-byte big-endian, centi-percent.
      var hraw = u16be(bytes[i + 1], bytes[i + 2]);
      if (hraw / 100 === 327.68) {
        fault = true;
      } else if (air.relativeHumidity === undefined) {
        air.relativeHumidity = round(hraw / 100, 2);
        if (channel === null) {
          channel = voie;
        }
      }
      sawTempOrHum = true;
      i += 3;
    } else if (isTest) {
      // Test frames may carry a leading non-TLV status byte; skip it.
      i += 1;
    } else {
      // Any other channel type is not part of a THX climate frame.
      i += 1;
    }
  }

  if (!sawTempOrHum) {
    return { errors: ['no temperature or humidity channel in measurement frame'] };
  }
  if (air.temperature === undefined && air.relativeHumidity === undefined) {
    return { errors: ['temperature/humidity sensor fault (all channels report the error sentinel)'] };
  }

  var data = { frameType: isTest ? FRAME_TYPE_LABEL.test : FRAME_TYPE_LABEL.measure };
  if (channel !== null) {
    data.channel = channel;
  }
  data.air = air;
  if (fault) {
    return { data: data, warnings: ['one or more channels report the sensor-fault sentinel'] };
  }
  return { data: data };
}

// Life frame ("Trame de vie"): optional 4-byte timestamp, then tensionv[2] and
// tensionc[2], each big-endian millivolts.
function decodeLife(bytes) {
  var horo = (nibbleBits((bytes[0] >> 4) & 0x0f)[1] === '1');
  var off = 1 + (horo ? 4 : 0);
  if (bytes.length < off + 4) {
    return { errors: ['life frame too short for battery voltage'] };
  }
  var data = { frameType: FRAME_TYPE_LABEL.life };
  data.battery = round(u16be(bytes[off], bytes[off + 1]) / 1000, 3);
  data.supplyVoltage = round(u16be(bytes[off + 2], bytes[off + 3]) / 1000, 3);
  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var ft = frameTypeOf(bytes);

  if (ft === 'measure') {
    // start_bcl: header byte (1) + optional 4-byte timestamp + optional 2-byte
    // period when the frame declares history/sampling.
    var oct1 = (bytes[0] >> 4) & 0x0f;
    var oct2 = bytes[0] & 0x0f;
    var b0 = nibbleBits(oct1);
    var b1 = nibbleBits(oct2);
    var hasHist = b0[3] === '1' || b1[0] === '1';
    var hasEchan = b1[1] === '1' || b1[2] === '1' || b1[3] === '1';
    var horo = b0[1] === '1';
    var start = 1;
    if (horo) {
      start += 4;
    }
    if (hasHist || hasEchan) {
      start += 2;
    }
    return decodeMeasurement(bytes, start, false);
  }

  if (ft === 'test') {
    return decodeMeasurement(bytes, 1, true);
  }

  if (ft === 'life') {
    return decodeLife(bytes);
  }

  return {
    errors: [
      'unsupported frame type "' + (FRAME_TYPE_LABEL[ft] || ft) +
        '": no temperature/humidity measurement to normalize'
    ]
  };
}
