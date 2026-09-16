// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for enginko/egk-lw20w00 (EGK-LW20W00 Waste Level
// Sensor): a battery-powered top-mounted ranging sensor for bins/containers
// (level up to 1.5 m) that also reports a derived fill percentage and an ambient
// temperature. The primary function is tank/silo level.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/enginko/decoder-level.js, referenced
// via egk-level-codec.yaml, attributed in NOTICE). Normalization authored here;
// upstream output (hex-reversed variable list, locale-formatted date, mm units)
// is NOT copied.
//
// All multi-byte fields are LITTLE-ENDIAN. Uplink id is bytes[0] (0x14 = level);
// bytes[1] selects the payload type. This waste-level device uses type 0x01:
//   bytes[0]      0x14 uplink id (level)
//   bytes[1]      0x01 payload type
//   bytes[2..5]   packed date/time bitfield (little-endian uint32)
//   bytes[6..7]   ADC (mV, little-endian)
//   bytes[8..9]   reserved
//   bytes[10..11] distance (mm, little-endian uint16); values > 60000 are the
//                 out-of-range error sentinel
//   bytes[12]     fill level (%)
//   bytes[13..14] temperature (little-endian signed-16, hundredths -> °C)
//   bytes[15]     battery (%)
//
// Normalization: tank/silo level device. distance (mm) -> tank.distance (m,
// ÷1000) and fill level -> tank.level (%) are the primary measurements; ambient
// temperature is secondary and maps to air.temperature (°C). Battery is a
// percentage -> `batteryPercent` (vocabulary `battery` is volts). The packed
// timestamp is decoded to an RFC3339 UTC `time`; ADC (mV) is a diagnostic extra.
// An out-of-range distance is flagged via `distanceError`, tank.distance omitted
// (tank.level still satisfies the tank-level category).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

function s16le(lo, hi) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  if (v & 0x8000) {
    v -= 0x10000;
  }
  return v;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Decode the enginko packed date/time bitfield (little-endian uint32) to RFC3339
// UTC. Layout (LSB first): seconds/2 (5b), minute (6b), hour (5b), day (5b),
// month (4b), year-2000 (7b).
function decodeTime(b0, b1, b2, b3) {
  var v = (b0 & 0xff) + ((b1 & 0xff) * 256) + ((b2 & 0xff) * 65536) + ((b3 & 0xff) * 16777216);
  var second = (v & 0x1f) * 2;
  v = Math.floor(v / 32);
  var minute = v & 0x3f;
  v = Math.floor(v / 64);
  var hour = v & 0x1f;
  v = Math.floor(v / 32);
  var day = v & 0x1f;
  v = Math.floor(v / 32);
  var month = v & 0x0f;
  v = Math.floor(v / 16);
  var year = (v & 0x7f) + 2000;
  return year + '-' + pad2(month) + '-' + pad2(day) + 'T' +
    pad2(hour) + ':' + pad2(minute) + ':' + pad2(second) + 'Z';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['missing or too-short payload'] };
  }
  if (bytes[0] !== 0x14) {
    return { errors: ['not a level uplink (expected id 0x14)'] };
  }
  if (bytes[1] !== 0x01) {
    return { errors: ['unsupported level payload type 0x' + bytes[1].toString(16)] };
  }
  if (bytes.length < 16) {
    return { errors: ['level type 0x01 frame too short (expected 16 bytes)'] };
  }

  var data = {};
  data.time = decodeTime(bytes[2], bytes[3], bytes[4], bytes[5]);
  data.adc = u16le(bytes[6], bytes[7]);

  var distanceMm = u16le(bytes[10], bytes[11]);
  var tank = { level: bytes[12] };
  if (distanceMm > 60000) {
    data.distanceError = true;
  } else {
    tank.distance = round(distanceMm / 1000, 3);
  }
  data.tank = tank;

  data.air = { temperature: round(s16le(bytes[13], bytes[14]) / 100, 2) };
  data.batteryPercent = bytes[15];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "enginko", model: "egk-lw20w00" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enginko";
    result.data.model = "egk-lw20w00";
  }
  return result;
}
