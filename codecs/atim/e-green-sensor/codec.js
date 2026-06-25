// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM E-GREEN-SENSOR (self-powered cable
// current/temperature sensor).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream file is ATIM's generic "ACW" decoder shared across the
// whole product line; the source of truth for the E-GREEN wire format is its
// measurement-frame path (`getFrameType` -> "Trame de mesure"/"Trame de test"
// -> `decodeFrame`) plus the life frame ("Trame de vie") and error frame
// ("Trame d'erreur"). The frame-type nibble logic and the channel/type TLV
// walk are ported faithfully:
//   type 0x0b = current  (2-byte big-endian, raw / 100 -> amperes)
//   type 0x0a = voltage  (2-byte big-endian, millivolts)
//   type 0x08 = temperature (2-byte big-endian signed, centi-degrees C;
//               -327.68 is the sensor-fault sentinel)
//
// Mapping into the normalized vocabulary:
//   measurement current     -> power.current        (A; satisfies power-meter)
//   measurement voltage     -> power.voltage         (V; tension is mV / 1000)
//   measurement temperature -> equipmentTemperature  (degrees C; the monitored
//                              equipment's temperature, not ambient air, soil,
//                              water or leaf -> camelCase extra)
//   life-frame tensionv     -> harvesterVoltage       (V; the energy-harvester
//                              rail. This device is self-powered with no battery
//                              or cell, so it is NOT mapped to `battery`.)
//   life-frame tensionc     -> capacitorVoltage       (V; storage-capacitor rail)
//   frame type              -> frameType              (camelCase extra)
//   measurement channel     -> channel                (camelCase extra; voie)
// Non-measurement/non-life frames and sensor faults yield errors/warnings.
//
// Scope note: ATIM measurement frames may carry a history of several samples
// (echan x historique) and an optional embedded timestamp/period. Deriving a
// trustworthy RFC3339 time per prior sample is not reliably possible from the
// canonical E-GREEN uplink, so this codec normalizes the most recent (index 0)
// sample of each channel rather than emit a `history` array without `time`.

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
// getFrameType for the cases the E-GREEN sensor emits.
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
// the first (most recent) sample of each current (0x0b), voltage (0x0a) and
// temperature (0x08) channel. start is the index of the first TLV byte.
function decodeMeasurement(bytes, start, isTest) {
  var power = {};
  var equipmentTemperature;
  var channel = null;
  var sawKnown = false;
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

    if (type === 0x0b) {
      // current: 2-byte big-endian, raw / 100 -> amperes.
      if (power.current === undefined) {
        power.current = round(u16be(bytes[i + 1], bytes[i + 2]) / 100, 2);
        if (channel === null) {
          channel = voie;
        }
      }
      sawKnown = true;
      i += 3;
    } else if (type === 0x0a) {
      // voltage: 2-byte big-endian millivolts -> volts.
      if (power.voltage === undefined) {
        power.voltage = round(u16be(bytes[i + 1], bytes[i + 2]) / 1000, 3);
        if (channel === null) {
          channel = voie;
        }
      }
      sawKnown = true;
      i += 3;
    } else if (type === 0x08) {
      // temperature: 2-byte big-endian signed, centi-degrees.
      var traw = s16be(bytes[i + 1], bytes[i + 2]);
      if (traw / 100 === -327.68) {
        fault = true;
      } else if (equipmentTemperature === undefined) {
        equipmentTemperature = round(traw / 100, 2);
        if (channel === null) {
          channel = voie;
        }
      }
      sawKnown = true;
      i += 3;
    } else {
      // Any other channel type is not part of an E-GREEN frame; step one byte.
      i += 1;
    }
  }

  if (!sawKnown) {
    return { errors: ['no current, voltage or temperature channel in measurement frame'] };
  }

  var haveValue = power.current !== undefined ||
    power.voltage !== undefined ||
    equipmentTemperature !== undefined;
  if (!haveValue) {
    return { errors: ['all channels report the sensor-fault sentinel'] };
  }

  var data = { frameType: isTest ? FRAME_TYPE_LABEL.test : FRAME_TYPE_LABEL.measure };
  if (channel !== null) {
    data.channel = channel;
  }
  if (power.current !== undefined || power.voltage !== undefined) {
    data.power = power;
  }
  if (equipmentTemperature !== undefined) {
    data.equipmentTemperature = equipmentTemperature;
  }
  if (fault) {
    return { data: data, warnings: ['one or more channels report the sensor-fault sentinel'] };
  }
  return { data: data };
}

// Life frame ("Trame de vie"): optional 4-byte timestamp, then tensionv[2] and
// tensionc[2], each big-endian millivolts. These are the self-powered device's
// internal harvester/capacitor rails (not a battery).
function decodeLife(bytes) {
  var horo = (nibbleBits((bytes[0] >> 4) & 0x0f)[1] === '1');
  var off = 1 + (horo ? 4 : 0);
  if (bytes.length < off + 4) {
    return { errors: ['life frame too short for supply voltages'] };
  }
  var data = { frameType: FRAME_TYPE_LABEL.life };
  data.harvesterVoltage = round(u16be(bytes[off], bytes[off + 1]) / 1000, 3);
  data.capacitorVoltage = round(u16be(bytes[off + 2], bytes[off + 3]) / 1000, 3);
  return { data: data };
}

function decodeUplinkCore(input) {
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
        '": no current/voltage/temperature measurement to normalize'
    ]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "e-green-sensor";
  }
  return result;
}
