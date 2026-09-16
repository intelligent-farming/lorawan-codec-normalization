// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-SMTP (Soil Moisture and Temperature
// Profile sensor for LoRaWAN) — a multi-depth profile probe reporting soil
// moisture and soil temperature at up to 8 discrete depths plus battery.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words) ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-smtp.js, attributed in
// NOTICE). The per-channel conversion formulas below are ported faithfully from
// the upstream SENSORS table; the upstream decodeUplink emits one raw object per
// depth (`soil_moisture_at_depth_N` / `soil_temperature_at_depth_N`). The
// results are then mapped onto the shared normalized vocabulary.
//
// Mapping: a multi-depth profile probe. Each connected depth becomes one
// entry in the reserved `channels` array (see AUTHORING.md "Multi-channel
// devices"), labelled `depth0`..`depth7` after the wire depth index and
// carrying that depth's soil.moisture (%) and soil.temperature (°C).
// Whole-device battery voltage is reported already in volts and stays
// top-level as `battery`. Physical depth in centimetres is NOT in the payload
// and varies by probe configuration (Decentlab sells custom lengths/level
// counts), so no per-entry soil.depth is emitted. The protocol version and
// device id (framing diagnostics the vocabulary does not model) are emitted
// as the camelCase extras `protocolVersion`/`deviceId`.
//
// Upstream conversions (ported verbatim):
//   soil moisture at depth k    = (word - 2500) / 500
//   soil temperature at depth k = (word - 32768) / 100   [°C]
//   battery voltage             = word / 1000            [V]
// A disconnected depth reads sentinels: moisture -5 and temperature -327.68,
// outside the vocabulary bounds for soil.moisture (0-100 %) and
// soil.temperature (>= -273.15 °C). Out-of-range values are dropped per
// depth, a depth with no in-range values gets no channels entry (a standard
// 6-level probe yields depth0..depth5), and the `channels` key is omitted
// when no depth is connected.

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
  //   bit0 soil profile (16 words: 8 depths, moisture+temperature interleaved)
  //   bit1 battery voltage (1 word)
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

  // bit0: 8-depth soil moisture (%) + temperature (°C) profile, interleaved.
  // One channels entry per connected depth; disconnected sentinels (-5,
  // -327.68) fall outside the vocabulary bounds and are dropped per value.
  if (words[0]) {
    var profileWords = words[0];
    var channels = [];
    var k;
    for (k = 0; k < 8; k++) {
      var moisture = round((profileWords[k * 2] - 2500) / 500, 3);
      var temperature = round((profileWords[k * 2 + 1] - 32768) / 100, 2);
      var soil = {};
      if (moisture >= 0 && moisture <= 100) {
        soil.moisture = moisture;
      }
      if (temperature >= -273.15) {
        soil.temperature = temperature;
      }
      if (soil.moisture !== undefined || soil.temperature !== undefined) {
        channels.push({ channel: 'depth' + k, soil: soil });
      }
    }
    if (channels.length > 0) {
      data.channels = channels;
    }
  }

  // bit1: battery voltage (V, already volts).
  if (words[1]) {
    data.battery = round(words[1][0] / 1000, 3);
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "decentlab", model: "dl-smtp" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "decentlab";
    result.data.model = "dl-smtp";
  }
  return result;
}
