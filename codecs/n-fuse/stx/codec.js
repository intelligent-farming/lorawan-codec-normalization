// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for n-fuse STX (Multisensor: HDC2080 temperature &
// humidity, BMA400 accelerometer, SFH7776 luminance, reed switch).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (fPort 1, 12-byte frame, format version 0x01) and the per-field bit
// math below are ported faithfully from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/n-fuse/stx.js, attributed in NOTICE;
// protocol: github.com/nfhw/stx-firmware MESSAGE_FORMAT_LORA_01.md) and then
// re-mapped onto the shared vocabulary. The upstream decode is the source of
// truth for the wire format; only the output shape is normalized here.
//
// Faithful quirks preserved from upstream:
//   - fPort must equal 1, else `unknown FPort`.
//   - The format-version guard `bytes[0] & 0xc0 != 0x40` is reproduced exactly.
//     JS operator precedence makes `0xc0 != 0x40` evaluate first (to `true`/1),
//     so this is effectively `(bytes[0] & 1)` — an odd byte[0] is rejected as
//     `unknown format version`. Kept verbatim to match upstream behavior.
//
// Mapping to vocabulary:
//   HDC2080 temperature -> air.temperature (°C)
//   HDC2080 humidity    -> air.relativeHumidity (%)
//   SFH7776 luminance   -> air.lightIntensity (lux; SFH7776 reports illuminance)
//   info.battery        -> battery (V; already volts upstream)
//   BMA400 axes + reference axes, txpower, format version, trigger reason ->
//     camelCase extras (genuine device data the vocabulary does not model).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// BMA400 raw count -> m/s² (upstream: (count / 128) * (2 * 9.80665)).
function accel(count) {
  return round((count / 128.0) * (2 * 9.80665), 4);
}

function triggerReason(index) {
  // Index ordering and strings preserved verbatim from upstream trigger_type.
  var table = [
    'Scheduled time interval',
    'Motion above threshold',
    'Light intensity above threshold',
    'Light intensity below threshold',
    'Temperature above threshold',
    'Temperature below threshold',
    'Humidity above threshold',
    'Humidity below threshold',
    'Reed switch'
  ];
  if (index >= 0 && index < table.length) {
    return table[index];
  }
  return null;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  // assert frame port 1 (ported verbatim)
  if (input.fPort != 1) {
    return { errors: ['unknown FPort'] };
  }
  // assert protocol version 01 (ported verbatim, including the precedence quirk)
  if (bytes[0] & 0xc0 != 0x40) {
    return { errors: ['unknown format version'] };
  }

  if (bytes.length < 12) {
    return { errors: ['frame too short: expected 12 bytes'] };
  }

  var data = {};
  var air = {};

  air.temperature = round((((bytes[9] << 1) & 0x100) | bytes[8]) / 512 * 165 - 40, 2);
  air.relativeHumidity = bytes[9] & 0x7f;
  air.lightIntensity = ((bytes[11] << 8) & 0x3f00) | bytes[10];
  data.air = air;

  // info.battery is already volts upstream: (bytes[1] & 0x7f) / 100 + 2.
  data.battery = round((bytes[1] & 0x7f) / 100 + 2, 2);

  // Genuine device data not modeled by the vocabulary -> camelCase extras.
  data.formatVersion = 0x01;
  data.txPower = (bytes[0] >> 2) & 0x0f;

  var triggerIndex = ((bytes[11] >> 3) & 0x18) | ((bytes[1] >> 5) & 0x40) | (bytes[0] & 0x03);
  data.triggerReason = triggerReason(triggerIndex);

  data.acceleration = {
    x: accel(bytes[2]),
    y: accel(bytes[3]),
    z: accel(bytes[4]),
    xReference: accel(bytes[5]),
    yReference: accel(bytes[6]),
    zReference: accel(bytes[7])
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "n-fuse";
    result.data.model = "stx";
  }
  return result;
}
