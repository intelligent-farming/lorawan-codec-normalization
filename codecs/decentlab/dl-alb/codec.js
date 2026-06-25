// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-ALB (albedometer sensor for
// LoRaWAN; vendor product page: "albedometer sensor for LoRaWAN"). Measures
// incoming (downwelling) and reflected (upwelling) shortwave solar radiation in
// W/m². The incoming shortwave radiation maps to the shared vocabulary key
// air.solarIrradiance (solar-radiation category); reflected radiation and the
// derived albedo ratio have no vocabulary home and become camelCase extras.
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-alb.js, attributed in
// NOTICE). Wire format is Decentlab protocol v2: version byte, 16-bit
// big-endian device id, 16-bit big-endian sensor flags bitmap, then
// per-flagged-sensor blocks of 16-bit big-endian words (LSB-first flag order).
//
// Unit normalization to the shared vocabulary:
//   - Incoming radiation: upstream (x - 32768) / 10 gives W/m² directly
//     (offset-binary 16-bit count), mapped to air.solarIrradiance.
//   - Reflected radiation: same transfer function, kept as the camelCase extra
//     reflectedRadiation (W/m²); can be slightly negative at night, so it is
//     not forced into the non-negative air.solarIrradiance key.
//   - albedo: dimensionless reflected/incoming ratio, camelCase extra albedo.
//   - Battery voltage: already volts (x / 1000), maps directly to `battery`.
//   - device id / protocol version map to camelCase extras.

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
  // upstream SENSORS table.
  // bit0: 2-word radiation block (incoming + reflected); bit1: 1-word battery.
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

  var data = {
    protocolVersion: version,
    deviceId: deviceId
  };
  var air = {};
  var hasAir = false;

  // bit0: radiation block -> incoming -> air.solarIrradiance (W/m²)
  if (words[0]) {
    var incoming = round((words[0][0] - 32768) / 10, 1);
    var reflected = round((words[0][1] - 32768) / 10, 1);
    air.solarIrradiance = incoming;
    hasAir = true;
    data.reflectedRadiation = reflected;
    // albedo = reflected / incoming when both are positive, else 0 (matches
    // the upstream guard).
    var rawIncoming = words[0][0] - 32768;
    var rawReflected = words[0][1] - 32768;
    if (rawIncoming > 0 && rawReflected > 0) {
      data.albedo = rawReflected / rawIncoming;
    } else {
      data.albedo = 0;
    }
  }

  // bit1: battery voltage (V, already volts)
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
    result.data.model = "dl-alb";
  }
  return result;
}
