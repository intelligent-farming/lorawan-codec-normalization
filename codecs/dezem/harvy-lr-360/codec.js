// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the deZem HarvyLR 360 — a self-powered LoRaWAN
// current sensor that measures AC/DC currents through a shunt/amplifier front
// end and reports the secondary (measured) current together with internal
// supply-rail diagnostics and an enclosure temperature.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed 30-byte big-endian frame) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/dezem/harvy-lr.js, attributed in NOTICE). The upstream `Decoder`
// emits raw vendor field names (isecCurrent_mA, vsysCurrent_mV, ...) and never
// errors on a malformed frame; the normalization below is authored here and is
// NOT a copy of that decoder.
//
// Calibrated field mapped to the vocabulary:
//   power.current (A) <- isecCurrent_mA, the instantaneous secondary current.
//     The wire value is in milliamps (field suffix _mA, raw/100), so it is
//     converted to amperes here (mA / 1000) for power-meter `power.current`.
//
// Genuine device data the vocabulary does not model travels as camelCase
// extras: firmwareVersion, shuntValueOhm, amplifierGain, the vsys* supply-rail
// voltages (mV), vampRmsMv (amplifier RMS, mV), the isec avg/min/max current
// statistics (mA, as measured), measurementsCounter, lastUploadSec, equipment
// temperature (degC) and powerLost. vsys is an internal rail, not a battery
// terminal voltage, so no `battery` key is emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, offset) {
  return (((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)) & 0xffff;
}

function s16be(bytes, offset) {
  var v = u16be(bytes, offset);
  if (v & 0x8000) {
    v = v - 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 30) {
    return {
      errors: [
        'HarvyLR frame too short (need 30 bytes, got ' +
          (bytes ? bytes.length : 0) + ')'
      ]
    };
  }

  // Raw secondary-current statistics in mA (wire units, raw/100).
  var isecCurrentMa = round(u16be(bytes, 13) / 100, 2);
  var isecAvgLongMa = round(u16be(bytes, 15) / 100, 2);
  var isecAvgShortMa = round(u16be(bytes, 17) / 100, 2);
  var isecMinMa = round(u16be(bytes, 19) / 100, 2);
  var isecMaxMa = round(u16be(bytes, 21) / 100, 2);

  var data = {
    // power.current (A): instantaneous secondary current, mA -> A.
    power: { current: round(isecCurrentMa / 1000, 5) },

    // Extras: device identity / configuration.
    firmwareVersion: 'v' + bytes[0] + '.' + bytes[1] + '.' + bytes[2],
    shuntValueOhm: round(bytes[3] / 10, 1),
    amplifierGain: bytes[4],

    // Internal supply-rail voltages (mV) — diagnostics, not a battery terminal.
    vsysCurrentMv: round(u16be(bytes, 5) / 10, 1),
    vsysMinMv: round(u16be(bytes, 7) / 10, 1),
    vsysMaxMv: round(u16be(bytes, 9) / 10, 1),
    vampRmsMv: round(u16be(bytes, 11) / 10, 1),

    // Secondary-current statistics (mA, as measured on the wire).
    isecAvgLongMa: isecAvgLongMa,
    isecAvgShortMa: isecAvgShortMa,
    isecMinMa: isecMinMa,
    isecMaxMa: isecMaxMa,

    measurementsCounter: u16be(bytes, 23),
    lastUploadSec: u16be(bytes, 25),
    temperature: round(s16be(bytes, 27) / 10, 1),
    powerLost: bytes[29]
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dezem";
    result.data.model = "harvy-lr-360";
  }
  return result;
}
