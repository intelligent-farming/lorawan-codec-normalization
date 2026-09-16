// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Makerfabs AgroSense Leaf Moisture SN-3001
// (leaf-surface wetness + leaf temperature + battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/leaf-moisture-sn-3001.js,
// attributed in NOTICE). Do NOT copy upstream normalization as our output.
//
// Wire layout (big-endian):
//   bytes[2]      battery, deci-volts  -> battery (V)
//   bytes[3]      "Significant" valid flag (0 = data invalid)
//   bytes[4..5]   leaf moisture, deci-percent -> leaf.wetness (%)
//   bytes[6..7]   leaf temperature, deci-°C, two's complement -> leaf.temperature (°C)
//   bytes[8..11]  reporting interval -> reportingInterval (extra)
//
// The SN-3001 is a CANOPY probe clipped to a leaf, not an ambient air sensor:
// the vendor describes it as measuring "leaf moisture and temperature ... for
// analyzing leaf conditions such as watering, moisturizing, dew, and freezing"
// (TTN vendor/makerfabs/leaf-moisture-sn-3001.yaml). Upstream emits the two
// channels as generic field2/field3, and the sensor's RH-style % scale makes
// `air.relativeHumidity` / `air.temperature` a tempting mapping — but those keys
// mean ambient air, and a leaf-surface reading published under them is not
// interchangeable with a real climate sensor's. The vocabulary models this
// device directly, so the channels normalize to `leaf.wetness` (%) and
// `leaf.temperature` (°C), and the device is a `leaf-wetness` member alongside
// dragino/llms01 rather than a `climate` one.

// UNRESOLVED — the scale of `reportingInterval`. The vendor's own downlink
// Encoder in reference/upstream-codec.js writes this SAME 4-byte big-endian field
// as SECONDS (minutes * 60, floored at 300), while its uplink decoder divides the
// field by 1000, i.e. reads it back as milliseconds. Both readings cannot be
// right, and nothing in the vendor material settles it. This codec keeps
// upstream's /1000 rather than silently picking the other reading, and the
// synthetic vectors carry wire values scaled to match — so if real hardware turns
// out to report seconds, the divisor here and those vector inputs move together
// (a device set to the 3600 s the vectors describe would then decode as 3.6).
// Confirm against a capture from a real unit before trusting this value.
// It is a camelCase extra, so no category membership or vocabulary key rides on it.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 12) {
    return { errors: ['payload too short: expected 12 bytes'] };
  }

  var significant = bytes[3];
  if (!significant) {
    return { errors: ['sensor reported data invalid (significant flag clear)'] };
  }

  var battery = round(bytes[2] / 10, 1);

  var wetness = round(((bytes[4] << 8) | bytes[5]) / 10, 1);

  var rawTemp = (bytes[6] << 8) | bytes[7];
  if (rawTemp >= 0x8000) {
    rawTemp -= 0x10000;
  }
  var temperature = round(rawTemp / 10, 1);

  var reportingInterval =
    (bytes[8] * 16777216 + bytes[9] * 65536 + bytes[10] * 256 + bytes[11]) / 1000;

  return {
    data: {
      leaf: {
        wetness: wetness,
        temperature: temperature
      },
      battery: battery,
      reportingInterval: reportingInterval
    }
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "makerfabs", model: "leaf-moisture-sn-3001" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "leaf-moisture-sn-3001";
  }
  return result;
}
