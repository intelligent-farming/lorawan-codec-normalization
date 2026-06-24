// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-PYR (total solar radiation /
// pyranometer sensor for LoRaWAN; vendor product page: "total solar radiation
// sensor for LoRaWAN"). Reports shortwave solar irradiance in W/m², mapped to
// the shared vocabulary key air.solarIrradiance (solar-radiation category).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-pyr.js, attributed in
// NOTICE). Wire format is Decentlab protocol v2: version byte, 16-bit
// big-endian device id, 16-bit big-endian sensor flags bitmap, then
// per-flagged-sensor blocks of 16-bit big-endian words (LSB-first flag order).
//
// Unit normalization to the shared vocabulary:
//   - Solar irradiance: upstream 3 * (x / 32768 - 1) * 1000 * 5 gives W/m²
//     directly (a per-sensor calibration factor folded into the transfer
//     function), mapped to air.solarIrradiance with no further conversion.
//   - Battery voltage: already volts (x / 1000), maps directly to `battery`.
//   - device id / protocol version map to camelCase extras; the raw 16-bit
//     irradiance count is preserved as the camelCase extra solarRadiationRaw.

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
  // bit0: 1-word total solar radiation; bit1: 1-word battery voltage.
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

  var data = {
    protocolVersion: version,
    deviceId: deviceId
  };
  var air = {};
  var hasAir = false;

  // bit0: total solar radiation (1 word) -> air.solarIrradiance (W/m²)
  if (words[0]) {
    var raw = words[0][0];
    air.solarIrradiance = round(3 * (raw / 32768 - 1) * 1000 * 5, 2);
    data.solarRadiationRaw = raw;
    hasAir = true;
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
    result.data.model = "dl-pyr";
  }
  return result;
}
