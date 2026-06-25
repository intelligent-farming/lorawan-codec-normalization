// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for moirelabs/p1at (Moire Labs P1AP digital
// gauge-pressure transducer).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/moirelabs/p1a-codec.js, attributed
// in NOTICE). The upstream codec emits the raw min/max/average/last pressure
// floats plus a unit-selector byte; we author the normalization here, mapping
// the current ("last") reading to the vocabulary key pressure.gauge (kPa)
// and converting from the device's reported engineering unit. We do NOT copy
// upstream normalizeUplink.
//
// Wire format (fPort 1, 17 bytes):
//   byte 0      unit selector: 0=C, 1=Pa, 2=kPa, 3=MPa
//   bytes 1-4   min pressure     (IEEE-754 little-endian float32)
//   bytes 5-8   max pressure     (float32)
//   bytes 9-12  average pressure (float32)
//   bytes 13-16 last pressure    (float32)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Decode 4 little-endian bytes as an IEEE-754 single-precision float.
function bytesToFloat(bytes) {
  var bits = (bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0];
  var sign = (bits >>> 31 === 0) ? 1.0 : -1.0;
  var e = (bits >>> 23) & 0xff;
  var m = (e === 0) ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * m * Math.pow(2, e - 150);
}

// Factor to convert the device's reported unit into kPa, or null if the unit
// is not a pressure unit the vocabulary models.
function kPaFactor(unitCode) {
  switch (unitCode) {
    case 1: return 0.001; // Pa  -> kPa
    case 2: return 1;     // kPa -> kPa
    case 3: return 1000;  // MPa -> kPa
    default: return null; // 0 = C (temperature) or unknown: not a pressure
  }
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 1) {
    return { errors: ['Unknown FPort - see device manual!'] };
  }
  if (!bytes || bytes.length < 17) {
    return { errors: ['Expected 17 bytes on fPort 1, got ' + (bytes ? bytes.length : 0)] };
  }

  var unitCode = bytes[0];
  var factor = kPaFactor(unitCode);
  if (factor === null) {
    return { errors: ['Unsupported pressure unit code ' + unitCode + ' - expected Pa, kPa or MPa'] };
  }

  var min = bytesToFloat(bytes.slice(1, 5)) * factor;
  var max = bytesToFloat(bytes.slice(5, 9)) * factor;
  var avg = bytesToFloat(bytes.slice(9, 13)) * factor;
  var last = bytesToFloat(bytes.slice(13, 17)) * factor;

  var data = {
    pressure: { gauge: round(last, 4) },
    pressureGaugeMin: round(min, 4),
    pressureGaugeMax: round(max, 4),
    pressureGaugeAverage: round(avg, 4)
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "moirelabs";
    result.data.model = "p1at";
  }
  return result;
}
