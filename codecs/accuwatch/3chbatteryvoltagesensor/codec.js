// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for accuwatch/3chbatteryvoltagesensor (Accuwatch
// 3-Channel Battery Voltage Sensor: three independent analog voltage channels).
// Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Accuwatch decoder
// (TheThingsNetwork/lorawan-devices vendor/accuwatch/3chbatteryvoltagesensor.js,
// attributed in NOTICE). Each channel is an IEEE-754 single-precision float in
// little-endian byte order (4 bytes). Upstream returns the three voltages as
// string keys (sensor1Voltage .. sensor3Voltage via toFixed(2)); this module
// authors numeric normalized vocabulary keys. Upstream normalization is never
// copied.
//
// 12-byte frame (little-endian float32 per channel):
//   bytes[0..3]   channel 1 voltage (V) -> analog.voltage
//   bytes[4..7]   channel 2 voltage (V) -> voltage2 (V extra)
//   bytes[8..11]  channel 3 voltage (V) -> voltage3 (V extra)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Decode a little-endian IEEE-754 float32 from bytes[i..i+3].
function f32le(b, i) {
  var bits = ((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0;
  var sign = (bits & 0x80000000) ? -1 : 1;
  var exponent = ((bits >>> 23) & 0xff) - 127;
  var significand = bits & 0x7fffff;

  if (exponent === 128) {
    return significand ? NaN : sign * Infinity;
  }
  if (exponent === -127) {
    if (significand === 0) {
      return sign * 0;
    }
    exponent = -126;
    significand = significand / (1 << 22);
  } else {
    significand = (significand | (1 << 23)) / (1 << 23);
  }
  return sign * significand * Math.pow(2, exponent);
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length !== 12) {
    return { errors: ['expected 12-byte frame, got ' + (b ? b.length : 0)] };
  }

  var v1 = f32le(b, 0);
  var v2 = f32le(b, 4);
  var v3 = f32le(b, 8);

  if (!isFinite(v1) || !isFinite(v2) || !isFinite(v3)) {
    return { errors: ['non-finite voltage in payload'] };
  }

  var data = {
    analog: { voltage: round(v1, 2) },
    voltage2: round(v2, 2),
    voltage3: round(v3, 2)
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "accuwatch";
    result.data.model = "3chbatteryvoltagesensor";
  }
  return result;
}
