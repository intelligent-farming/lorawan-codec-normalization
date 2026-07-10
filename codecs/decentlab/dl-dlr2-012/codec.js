// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-DLR2-012 (Analog Strain Gauge Sensor
// Transmitter for LoRaWAN): a generic ratiometric analog transmitter wired to a
// bridge-type strain gauge. It is fundamentally an analog interface — the
// attached probe defines the physical quantity — so it maps to the
// `analog-interface` category rather than a strain-specific category. Because
// the upstream output unit is µm·m⁻¹ (microstrain), which the analog vocabulary
// cannot represent, the normalized reading is the raw ratiometric ADC count
// (`analog.raw`); the upstream's linearized strain is preserved verbatim as the
// extra strainMicrostrain.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported faithfully from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-dlr2-012.js,
// attributed in NOTICE). The per-sensor conversion formula below is ported
// verbatim from the upstream SENSORS table; the result is then mapped onto the
// shared normalized vocabulary. Upstream normalizeUplink is NOT copied.
//
// Mapping (flag bit order, LSB first):
//   bit0 strain-gauge block (2 words, x[0]/x[1] form a 24-bit ratiometric
//     count): analog.raw = x[0] + x[1]*65536 (raw ADC count). Upstream
//     linearized strain (µm·m⁻¹) is emitted as the extra strainMicrostrain:
//       ((x[0] + x[1]*65536) / 8388608 - 1) / 64 * 4 / 2.02 * 1000000
//   bit1 battery (1 word): x[0] / 1000 -> V -> `battery`.
// Protocol header fields are emitted as the extras protocolVersion / deviceId.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short: need at least 5 header bytes'] };
  }

  var version = bytes[0];
  if (version !== 2) {
    return { errors: ["protocol version " + version + " doesn't match v2"] };
  }

  var deviceId = u16be(bytes[1], bytes[2]);
  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first):
  //   bit0 strain gauge (2 words), bit1 battery (1 word).
  var lengths = [2, 1];

  var pos = 5;
  var words = [];
  var i;
  var f = flags;
  for (i = 0; i < lengths.length; i++) {
    if (f & 1) {
      var block = [];
      var j;
      for (j = 0; j < lengths[i]; j++) {
        if (pos + 1 >= bytes.length) {
          return { errors: ['payload too short: truncated sensor block'] };
        }
        block.push(u16be(bytes[pos], bytes[pos + 1]));
        pos += 2;
      }
      words[i] = block;
    }
    f >>= 1;
  }

  var data = {};
  data.protocolVersion = version;
  data.deviceId = deviceId;

  var hasAnalog = false;

  // bit0: strain-gauge ratiometric analog input.
  if (words[0]) {
    var x0 = words[0][0];
    var x1 = words[0][1];
    var raw = x0 + x1 * 65536;
    var strain = (raw / 8388608 - 1) / 64 * 4 / 2.02 * 1000000;
    data.analog = { raw: raw };
    data.strainMicrostrain = round(strain, 4);
    hasAnalog = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (!hasAnalog) {
    return { errors: ['no analog field in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-dlr2-012";
  }
  return result;
}
