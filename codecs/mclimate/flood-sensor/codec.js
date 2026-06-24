// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for mclimate/flood-sensor (MClimate Flood Sensor).
// Water/flood detection + device temperature.
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/flood-sensor.js, attributed
// in NOTICE). The wire format was read from upstream; the normalization below is
// authored for this module's fixed vocabulary — upstream normalizeUplink is NOT
// copied as output.
//
// Wire format:
//   byte[0] bits (MSB-first, 8 chars): [0..2] reason index, [4] boxTamper, [6] flood
//   byte[1]            battery raw; volts = raw * 16 / 1000
//   byte[2] (optional) device temperature (deg C, unsigned integer)
// 2-byte frame = short (periodic) package; 3-byte frame = long package (adds temp).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short: expected at least 2 bytes'] };
  }
  if (bytes.length > 3) {
    return { errors: ['payload too long: expected at most 3 bytes'] };
  }

  var i;
  for (i = 0; i < bytes.length; i++) {
    if (typeof bytes[i] !== 'number' || bytes[i] < 0 || bytes[i] > 255) {
      return { errors: ['invalid byte at index ' + i + ': must be 0-255'] };
    }
  }

  var reasons = ['keepalive', 'testButtonPressed', 'floodDetected', 'fraudDetected'];

  // Render byte[0] as an 8-char MSB-first binary string.
  var b0 = bytes[0];
  var bin = b0.toString(2);
  while (bin.length < 8) {
    bin = '0' + bin;
  }

  var reasonIndex = parseInt(bin.slice(0, 3), 2);
  var reason = reasons[reasonIndex];
  var boxTamper = bin.charAt(4) === '1';
  var flood = bin.charAt(6) === '1';

  var batteryVolts = round((bytes[1] * 16) / 1000, 3);

  var data = {
    water: {
      leak: flood
    },
    battery: batteryVolts,
    boxTamper: boxTamper
  };

  if (reason !== undefined) {
    data.reason = reason;
  }

  if (bytes.length === 3) {
    data.water.temperature = { current: bytes[2] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mclimate";
    result.data.model = "flood-sensor";
  }
  return result;
}
