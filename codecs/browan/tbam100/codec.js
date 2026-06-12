// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Browan TBAM100 (Ambient Light Sensor), data
// uplink on fPort 104.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/browan/tbam100.js, attributed in
// NOTICE). Illuminance (3-byte LE, 0.01 lux) -> air.lightIntensity; battery is
// volts. The board temperature and the darker/lighter/status flags are
// device-specific camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 104) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 104)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
  }

  var data = {};

  // Byte 1 low nibble: battery, 2.5 V + 0.1 V steps.
  data.battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);

  // Bytes 3-5: illuminance, 24-bit LE, 0.01 lux.
  var luxRaw = (bytes[5] << 16) | (bytes[4] << 8) | bytes[3];
  data.air = { lightIntensity: round(luxRaw / 100, 2) };

  // Byte 2 low 7 bits: board temperature, -32 C offset (device-specific extra).
  data.boardTemperature = (bytes[2] & 0x7f) - 32;

  // Byte 0: status flags (device-specific extras).
  data.darker = (bytes[0] & 0x01) === 0x01;
  data.lighter = ((bytes[0] >> 1) & 0x01) === 0x01;
  data.statusChange = ((bytes[0] >> 4) & 0x01) === 0x01;
  data.keepAlive = ((bytes[0] >> 5) & 0x01) === 0x01;

  return { data: data };
}
