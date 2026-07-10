// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-ISF (Sapflow Sensor for LoRaWAN):
// a heat-ratio sap-flow probe measuring sap movement through a plant stem plus
// a range of heat-pulse diagnostics. The primary measurement is the sap-flow
// rate, so this device maps to the `sap-flow` category (`plant.sapFlow` in
// g/h).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported faithfully from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-isf.js,
// attributed in NOTICE). The per-sensor conversion formulas below are ported
// verbatim from the upstream SENSORS table; the results are then mapped onto
// the shared normalized vocabulary. Upstream normalizeUplink is NOT copied.
//
// Mapping (flag bit order, LSB first):
//   bit0 sap-flow block (16 words). Upstream reports sap_flow in l·h⁻¹
//     (litres per hour). The vocabulary `plant.sapFlow` is g/h; sap is treated
//     as water (density 1 g/mL, i.e. 1 L = 1000 g), so:
//       plant.sapFlow = (x[0] * 16 - 50000) / 1000 * 1000
//                     =  x[0] * 16 - 50000            (g/h).
//     The remaining channels are not modelled by the vocabulary and are
//     emitted as camelCase extras (heat velocities, alpha/beta ratios, Tmax
//     values, probe voltages, diagnostic). temperatureOuter is the probe's
//     own reference temperature (not ambient air), so it stays an extra too.
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
  //   bit0 sap-flow diagnostics (16 words), bit1 battery (1 word).
  var lengths = [16, 1];

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

  var hasSapFlow = false;

  // bit0: sap-flow diagnostics block.
  if (words[0]) {
    var x = words[0];
    // sap flow: l/h -> g/h (water density 1 g/mL, ×1000).
    data.plant = { sapFlow: round((x[0] * 16 - 50000) / 1000 * 1000, 3) };
    data.heatVelocityOuter = round((x[1] * 16 - 50000) / 1000, 3);
    data.heatVelocityInner = round((x[2] * 16 - 50000) / 1000, 3);
    data.alphaOuter = round((x[3] * 32 - 1000000) / 100000, 5);
    data.alphaInner = round((x[4] * 32 - 1000000) / 100000, 5);
    data.betaOuter = round((x[5] * 32 - 1000000) / 100000, 5);
    data.betaInner = round((x[6] * 32 - 1000000) / 100000, 5);
    data.tmaxOuter = round((x[7] * 2) / 1000, 3);
    data.tmaxInner = round((x[8] * 2) / 1000, 3);
    data.temperatureOuter = round((x[9] - 32768) / 100, 2);
    data.maxVoltage = round((x[10] - 32768) / 1000, 3);
    data.minVoltage = round((x[11] - 32768) / 1000, 3);
    data.diagnostic = x[12] + x[13] * 65536;
    data.upstreamTmaxOuter = round((x[14] * 2) / 1000, 3);
    data.upstreamTmaxInner = round((x[15] * 2) / 1000, 3);
    hasSapFlow = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (!hasSapFlow) {
    return { errors: ['no sap-flow field in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-isf";
  }
  return result;
}
