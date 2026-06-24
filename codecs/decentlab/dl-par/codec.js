// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-PAR (Photosynthetically Active
// Radiation Sensor for LoRaWAN).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-par.js, attributed in
// NOTICE). The upstream decodeUplink emits the raw Decentlab per-sensor
// objects; the per-sensor conversion formulas below are ported faithfully and
// the results are then mapped onto the shared normalized vocabulary.
//
// Mapping: photosynthetically_active_radiation (upstream µmol⋅m⁻²⋅s⁻¹, formula
// 3 * (raw / 32768 - 1) * 1000 * 5) -> air.par (µmol/m²/s); battery_voltage
// (already volts) -> battery. The Decentlab protocol version and device id are
// emitted as the camelCase extras `protocolVersion` and `deviceId`.

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

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table:
  //   bit0 photosynthetically active radiation (1 word), bit1 battery (1 word)
  var lengths = [1, 1];

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

  var air = {};
  var hasAir = false;

  // bit0: photosynthetically active radiation. Upstream formula, µmol⋅m⁻²⋅s⁻¹.
  if (words[0]) {
    var par = 3 * (words[0][0] / 32768 - 1) * 1000 * 5;
    air.par = round(par, 2);
    hasAir = true;
  }

  // bit1: battery voltage (already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-par";
  }
  return result;
}
