// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Senzemo SMC30 (Senstick Microclimate:
// air temperature, relative humidity and barometric pressure).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed-layout big-endian frame; data on fPort 1/2, config on other
// ports) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/senzemo/smc30.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// SMC30 reports battery as a VOLTAGE — upstream computes (byte + 100) / 100,
// giving ~1.00-3.55 V — so it maps directly to the vocabulary's `battery`
// field. Barometric pressure is reported in deci-hPa (upstream / 10), already
// hPa after scaling. Temperature and humidity are centi-units (upstream / 100).
// The device status byte and the config-frame device identifiers have no
// vocabulary key, so they are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes) {
    return { errors: ['no payload bytes'] };
  }

  // Data packet (measurement frame): fPort 1 or 2, 8 bytes.
  if (port === 1 || port === 2) {
    if (bytes.length < 8) {
      return { errors: ['data packet too short: need 8 bytes, got ' + bytes.length] };
    }

    var data = {};
    var air = {};

    // bytes[1..2]: temperature, signed centi-degrees -> °C
    air.temperature = round(s16be(bytes[1], bytes[2]) / 100, 2);
    // bytes[3..4]: relative humidity, centi-percent -> %
    air.relativeHumidity = round(u16be(bytes[3], bytes[4]) / 100, 2);
    // bytes[5..6]: barometric pressure, deci-hPa -> hPa
    air.pressure = round(u16be(bytes[5], bytes[6]) / 10, 1);

    data.air = air;
    // bytes[7]: battery, (byte + 100) / 100 -> V
    data.battery = round((bytes[7] + 100) / 100, 2);
    // bytes[0]: device status byte (no vocabulary key)
    data.status = bytes[0];

    return { data: data };
  }

  // Config packet: device identification / settings frame, 9 bytes.
  if (bytes.length < 9) {
    return { errors: ['config packet too short: need 9 bytes, got ' + bytes.length] };
  }

  return {
    data: {
      status: bytes[0],
      sendPeriod: bytes[1],
      movementThreshold: bytes[2],
      packetConfirm: bytes[3],
      dataRate: bytes[4],
      familyId: bytes[5],
      productId: bytes[6],
      hardwareVersion: round(bytes[7] / 10, 1),
      firmwareVersion: round(bytes[8] / 10, 1)
    }
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "senzemo";
    result.data.model = "smc30";
  }
  return result;
}
