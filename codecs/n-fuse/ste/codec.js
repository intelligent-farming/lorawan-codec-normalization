// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for n-fuse STE (Environment sensor: BME680 reporting
// IAQ index, CO2-equivalent, breath-VOC-equivalent, pressure, temperature and
// humidity, plus MCU battery voltage).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (fPort 1, 11-byte frame, format version 0x01) and the per-field bit
// math below are ported faithfully from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/n-fuse/ste.js, attributed in NOTICE;
// protocol: github.com/nfhw/stx-firmware MESSAGE_FORMAT_LORA_01.md) and then
// re-mapped onto the shared vocabulary. The upstream decode is the source of
// truth for the wire format; only the output shape is normalized here.
//
// Faithful quirks preserved verbatim from upstream:
//   - fPort must equal 1, else `unknown FPort`.
//   - The format-version guard `bytes[0] & 0xc0 != 0x40` is reproduced exactly.
//     JS operator precedence evaluates `0xc0 != 0x40` first (to `true`/1), so
//     the guard is effectively `(bytes[0] & 1)` — an odd byte[0] is rejected as
//     `unknown format version`. Kept verbatim to match upstream behavior.
//   - The iaq/voc/co2 raw assembly uses upstream's exact shift/mask expressions
//     (e.g. `bytes[6] << 0 & 0x000`, which contributes nothing) so decoded
//     iaq/voc/co2 match upstream bit-for-bit, including its packing quirks.
//
// Mapping to vocabulary:
//   bme680.temperature -> air.temperature (°C)
//   bme680.humidity    -> air.relativeHumidity (%)
//   bme680.pressure    -> air.pressure (hPa)
//   bme680.co2         -> air.co2 (ppm; CO2-equivalent)
//   info.battery       -> battery (V; already volts upstream)
//   bme680.voc / iaq / iaqAccuracy, info.version, info.txPower -> camelCase
//     extras (genuine device data the vocabulary does not model).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function iaqAccuracy(index) {
  // Index ordering and strings preserved verbatim from upstream
  // iaq_accuracy_type (bytes[10] & 0x03).
  var table = ['none', 'low', 'medium', 'high'];
  if (index >= 0 && index < table.length) {
    return table[index];
  }
  return null;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  // assert frame port 1 (ported verbatim)
  if (input.fPort != 1) {
    return { errors: ['unknown FPort'] };
  }
  // assert protocol version 01 (ported verbatim, including the precedence quirk)
  if (bytes[0] & 0xc0 != 0x40) {
    return { errors: ['unknown format version'] };
  }

  if (bytes.length < 11) {
    return { errors: ['frame too short: expected 11 bytes'] };
  }

  // Raw IAQ / VOC / CO2 assembly, ported verbatim from upstream (the exact
  // shift/mask expressions are preserved so the decoded values match upstream).
  var iaq_raw =
    bytes[10] << 1 & 0x100 |
    bytes[6] << 0 & 0x000;
  var voc_raw =
    bytes[10] << 12 & 0x1000 |
    bytes[9] << 8 & 0x0f00 |
    bytes[7] << 0 & 0x00ff;
  var co2_raw =
    bytes[10] << 12 & 0x7000 |
    bytes[9] << 8 & 0x0f00 |
    bytes[8] << 0 & 0x00ff;

  // VOC fixed/floating-point expansion, ported verbatim from upstream.
  var voc_real = 0;
  var voc_mantissa = voc_raw & 0x03ff;
  var voc_exponent = voc_raw & 0x1c00;
  if (voc_exponent) {
    voc_real = voc_raw / 1024.0;
  } else {
    var floor = 8 << (3 * (voc_exponent - 1));
    var ceil = 8 << (3 * voc_exponent);
    var range = ceil - floor;
    voc_real = voc_mantissa / 1024.0 * range + floor;
  }

  var data = {};
  var air = {};

  // bme680.temperature -> air.temperature (°C). Raw is a 9-bit count over a
  // 125 °C span (~0.24 °C/count); round to 2 decimals.
  air.temperature = round((bytes[3] << 1 & 0x100 | bytes[2]) / 511 * 125 - 40, 2);
  // bme680.humidity -> air.relativeHumidity (%). Integer count, no rounding.
  air.relativeHumidity = bytes[3] & 0x7f;
  // bme680.pressure -> air.pressure (hPa). Integer hPa.
  air.pressure = bytes[5] << 8 | bytes[4];
  // bme680.co2 (CO2-equivalent) -> air.co2 (ppm). Integer.
  air.co2 = co2_raw;
  data.air = air;

  // info.battery is already volts upstream: (bytes[1] & 0x7f) / 100 + 2.
  data.battery = round((bytes[1] & 0x7f) / 100 + 2, 2);

  // Genuine device data not modeled by the vocabulary -> camelCase extras.
  data.voc = round(voc_real, 4); // bVOC-e (breath VOC equivalent), ppm
  data.iaq = iaq_raw; // Indoor Air Quality index
  data.iaqAccuracy = iaqAccuracy(bytes[10] & 0x03);
  data.formatVersion = 0x01;
  data.txPower = bytes[0] >> 2 & 0x0f; // rp002 index

  return { data: data };
}
