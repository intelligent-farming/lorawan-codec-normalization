// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RiverCity Innovations TxH (Temperature &
// Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (per-fPort frames, big-endian uint16 sensor fields) was ported from
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/rivercity-innovations/txh.js, attributed in NOTICE). The decode logic
// below is ported from that reference; the normalization (vocabulary keys vs.
// camelCase extras) is authored here — the upstream returns a flat bag of
// fields, which we do not reproduce verbatim.
//
// fPorts (input.fPort): 2 = regular reading (temperature/humidity, alert
// flags, optional battery), 3 = version info, 5 = device settings,
// 6 = uplink/check timing. Only fPort 2 carries climate measurements. All
// 16-bit fields are BIG-endian and two's-complement signed: bytes[hi]*256 +
// bytes[lo], with values >= 0x8000 treated as negative (value - 0x10000),
// matching upstream exactly.
//
// Vocabulary mapping (fPort 2): temperature -> air.temperature (C, signed/10),
// humidity -> air.relativeHumidity (%, signed/10), battery -> battery (the
// device reports battery in MILLIVOLTS, which divided by 1000 is already the
// vocabulary's volts, so it maps to `battery`, not `batteryPercent`). The two
// alert flags have no vocabulary key and are emitted as camelCase extras
// (temperatureAlertActive, humidityAlertActive). All fields on the other
// fPorts (version strings, configured limits, enable flags, timing counters)
// have no vocabulary key and are emitted as camelCase extras matching the
// upstream field names.
//
// BANNED (TTN/ChirpStack console-paste rules, statically linted): no require/
// import/export/module.exports/exports, no process/Buffer/globalThis, no eval/
// new Function, no timers, no console, no fetch, no async/await/Promise, and no
// post-ES2017 syntax (?., ??, ..., BigInt/123n, #private, static{}). ES5 style
// only: var, function declarations, Math/JSON/Date, JSON-serializable output.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned 16-bit, matching upstream (bytes[hi]*256 + bytes[lo]).
function u16be(bytes, hi, lo) {
  return ((bytes[hi] << 8) | bytes[lo]) & 0xffff;
}

// Big-endian signed 16-bit (two's complement), matching upstream
// (value >= 0x8000 ? value - 0x10000 : value).
function s16be(bytes, hi, lo) {
  var v = u16be(bytes, hi, lo);
  return v >= 0x8000 ? v - 0x10000 : v;
}

// Regular reading (fPort 2): climate measurements + alert flags + optional
// battery. temperature/humidity -> air.*, battery (mV/1000 = V) -> battery,
// alert flags -> camelCase extras.
function decodeRegular(bytes, data, air) {
  air.temperature = round(s16be(bytes, 0, 1) / 10, 1);
  air.relativeHumidity = round(s16be(bytes, 2, 3) / 10, 1);

  data.temperatureAlertActive = (bytes[4] & 0x02) === 0x02;
  data.humidityAlertActive = (bytes[4] & 0x01) === 0x01;

  // Battery (bytes 5 & 6) is optional; present only on longer frames.
  if (bytes.length > 5) {
    data.battery = round(u16be(bytes, 5, 6) / 1000, 3);
  }
}

// Version info (fPort 3): dotted hex version strings -> camelCase extras.
function decodeVersion(bytes, data) {
  data.loRaWANVersion =
    bytes[0].toString(16) +
    '.' +
    bytes[1].toString(16) +
    '.' +
    bytes[2].toString(16) +
    '.' +
    bytes[3].toString(16);
  data.firmwareVersion =
    bytes[4].toString(16) +
    '.' +
    bytes[5].toString(16) +
    '.' +
    bytes[6].toString(16) +
    '.' +
    bytes[7].toString(16);
}

// Device settings (fPort 5): configured limits + enable flags -> camelCase
// extras. Limits are signed/10 like the live readings.
function decodeSettings(bytes, data) {
  data.temperatureLimitHigh = round(s16be(bytes, 0, 1) / 10, 1);
  data.temperatureLimitLow = round(s16be(bytes, 2, 3) / 10, 1);
  data.humidityLimitHigh = round(s16be(bytes, 4, 5) / 10, 1);
  data.humidityLimitLow = round(s16be(bytes, 6, 7) / 10, 1);
  data.dataAverageNumber = bytes[8];

  data.temperatureAlertsEnabled = (bytes[9] & 0x10) > 0;
  data.humidityAlertsEnabled = (bytes[9] & 0x08) > 0;
  data.adrOn = (bytes[9] & 0x04) > 0;
  data.confirmedUplinks = (bytes[9] & 0x02) > 0;
  data.isAlertsConfirmed = (bytes[9] & 0x01) > 0;
}

// Uplink/check timing (fPort 6): big-endian counters -> camelCase extras.
function decodeTiming(bytes, data) {
  data.checkTimeSeconds =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  data.reportsNumChecksRegular = u16be(bytes, 4, 5);
  data.reportsNumChecksAlert = u16be(bytes, 6, 7);
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;

  if (input.fPort === 2) {
    if (bytes.length < 5) {
      return { errors: ['payload too short for a fPort 2 regular reading'] };
    }
    decodeRegular(bytes, data, air);
    hasAir = true;
  } else if (input.fPort === 3) {
    if (bytes.length < 8) {
      return { errors: ['payload too short for a fPort 3 version frame'] };
    }
    decodeVersion(bytes, data);
  } else if (input.fPort === 5) {
    if (bytes.length < 10) {
      return { errors: ['payload too short for a fPort 5 settings frame'] };
    }
    decodeSettings(bytes, data);
  } else if (input.fPort === 6) {
    if (bytes.length < 8) {
      return { errors: ['payload too short for a fPort 6 timing frame'] };
    }
    decodeTiming(bytes, data);
  } else {
    return { errors: ['unsupported fPort ' + input.fPort] };
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
