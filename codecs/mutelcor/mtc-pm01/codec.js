// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Mutelcor MTC-PM01 "LoRa PM2.5 Sensor"
// (laser-scattering particulate monitor: PM1.0/PM2.5/PM10 + TVOC + temperature
// + relative humidity, plus optional pressure / light / CO2 / distance /
// digital inputs depending on the configured measurement set).
//
// The wire format (the shared Mutelcor "LoRaButton" framing: byte[0] = payload
// version, byte[1..2] = battery/input voltage in 10 mV big-endian / 100,
// byte[3] = OpCode, then an OpCode-specific body) was ported from and decoded
// against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mutelcor/mutelcor.js, attributed in
// NOTICE). For this device the relevant body is OpCode 3 "Measurements"
// (OpCode 5 "Thresholds" shares the same measurement block): byte[4] is a
// measurement-present bitmask, and each set bit pulls a field off the stream in
// order — temperature (bit0, signed 16-bit /10 °C), relative humidity (bit1,
// 1 byte %), pressure (bit2, 16-bit /10 hPa), light (bit3, 16-bit lux), CO2
// (bit4, 16-bit ppm), TVOC (bit5, 16-bit ppb), distance (bit6, 16-bit mm), and
// an extension bit (bit7) introducing a second bitmask whose bit0 = digital
// inputs (1 byte) and bit1 = particulate matter (three 16-bit µg/m³ values:
// PM1.0, PM2.5, PM10).
//
// The upstream byte slicing, the signed-temperature reconstruction (the
// `<<16 ... /655360` trick == int16/10) and the measurement-bitmask walk are
// reproduced faithfully; only the JSON shape is re-authored to the normalized
// vocabulary (never the upstream normalizeUplink/normalizedOutput).
//
// Normalization decisions:
//   - PM1.0 -> air.pm1_0, PM2.5 -> air.pm2_5, PM10 -> air.pm10 (all µg/m³,
//     emitted as-is — the laser-scattering sensor reports integer mass
//     concentration).
//   - TVOC -> air.tvoc (ppb, emitted as-is; the vocabulary unit is already ppb).
//   - Temperature -> air.temperature (°C), relative humidity ->
//     air.relativeHumidity (%).
//   - Pressure -> air.pressure (hPa), light -> air.lightIntensity (lux),
//     CO2 -> air.co2 (ppm) when present in the configured measurement set.
//   - Battery/input voltage -> `battery` (V); the upstream value is already
//     volts (10 mV units / 100).
//   - Distance (ultrasonic/ToF), digital-input states, and threshold
//     trigger/stop flags have no vocabulary home, so they are emitted as
//     camelCase extras: distanceMm, digitalInputs, thresholdsTriggered,
//     thresholdsStopped.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var pos = 0;

  if (!bytes || bytes.length === 0) {
    return { errors: ["empty payload"] };
  }
  // version
  pos += 1;
  if (bytes.length < pos + 2) {
    return { errors: ["unexpected end: no (complete) voltage"] };
  }
  var voltage = (bytes[pos] * 256 + bytes[pos + 1]) / 100;
  pos += 2;
  if (bytes.length < pos + 1) {
    return { errors: ["unexpected end: no OpCode"] };
  }
  var opcode = bytes[pos];
  pos += 1;

  // This device emits its sensor readings under OpCode 3 (Measurements);
  // OpCode 5 (Thresholds) carries the same measurement block.
  if (opcode !== 3 && opcode !== 5) {
    return { errors: ["unsupported OpCode " + opcode + " (expected 3 Measurements or 5 Thresholds)"] };
  }

  if (bytes.length < pos + 1) {
    return { errors: ["unexpected end: Measurements requires a measurement bitmask"] };
  }
  var mask = bytes[pos];
  pos += 1;

  var air = {};
  var extras = {};

  if (mask & 1) {
    if (bytes.length < pos + 2) {
      return { errors: ["unexpected end: incomplete Temperature value"] };
    }
    var traw = bytes[pos] * 256 + bytes[pos + 1];
    if (traw > 32767) traw -= 65536;
    air.temperature = round(traw / 10, 1);
    pos += 2;
  }
  if (mask & 2) {
    if (bytes.length < pos + 1) {
      return { errors: ["unexpected end: missing Relative Humidity value"] };
    }
    air.relativeHumidity = bytes[pos];
    pos += 1;
  }
  if (mask & 4) {
    if (bytes.length < pos + 2) {
      return { errors: ["unexpected end: incomplete Pressure value"] };
    }
    air.pressure = round((bytes[pos] * 256 + bytes[pos + 1]) / 10, 1);
    pos += 2;
  }
  if (mask & 8) {
    if (bytes.length < pos + 2) {
      return { errors: ["unexpected end: incomplete Light value"] };
    }
    air.lightIntensity = bytes[pos] * 256 + bytes[pos + 1];
    pos += 2;
  }
  if (mask & 16) {
    if (bytes.length < pos + 2) {
      return { errors: ["unexpected end: incomplete CO2 value"] };
    }
    air.co2 = bytes[pos] * 256 + bytes[pos + 1];
    pos += 2;
  }
  if (mask & 32) {
    if (bytes.length < pos + 2) {
      return { errors: ["unexpected end: incomplete TVOC value"] };
    }
    air.tvoc = bytes[pos] * 256 + bytes[pos + 1];
    pos += 2;
  }
  if (mask & 64) {
    if (bytes.length < pos + 2) {
      return { errors: ["unexpected end: incomplete Distance value"] };
    }
    extras.distanceMm = bytes[pos] * 256 + bytes[pos + 1];
    pos += 2;
  }
  if (mask & 128) {
    if (bytes.length < pos + 1) {
      return { errors: ["unexpected end: missing extended measurement bitmask"] };
    }
    var emask = bytes[pos];
    pos += 1;
    if (emask & 1) {
      if (bytes.length < pos + 1) {
        return { errors: ["unexpected end: missing Digital Inputs"] };
      }
      var di = bytes[pos];
      pos += 1;
      var digitalInputs = {};
      for (var d = 0; d < 4; d += 1) {
        if (di & (1 << d)) {
          digitalInputs[d + 1] = (di & (1 << (d + 4))) !== 0;
        }
      }
      extras.digitalInputs = digitalInputs;
    }
    if (emask & 2) {
      if (bytes.length < pos + 6) {
        return { errors: ["unexpected end: incomplete Particulate Matter"] };
      }
      air.pm1_0 = bytes[pos] * 256 + bytes[pos + 1];
      air.pm2_5 = bytes[pos + 2] * 256 + bytes[pos + 3];
      air.pm10 = bytes[pos + 4] * 256 + bytes[pos + 5];
      pos += 6;
    }
  }

  // OpCode 5 carries a trailing threshold-info byte: low nibble = triggered
  // thresholds, high nibble = stopped thresholds.
  if (opcode === 5) {
    if (bytes.length < pos + 1) {
      return { errors: ["unexpected end: Thresholds requires threshold info"] };
    }
    var ti = bytes[pos];
    pos += 1;
    var triggered = [];
    var stopped = [];
    for (var t = 0; t < 4; t += 1) {
      if (ti & (1 << t)) triggered.push(t + 1);
      if (ti & (1 << (t + 4))) stopped.push(t + 1);
    }
    if (triggered.length) extras.thresholdsTriggered = triggered;
    if (stopped.length) extras.thresholdsStopped = stopped;
  }

  var data = { battery: round(voltage, 2) };
  var hasAir = false;
  var k;
  for (k in air) {
    if (air.hasOwnProperty(k)) { hasAir = true; break; }
  }
  if (hasAir) data.air = air;
  for (k in extras) {
    if (extras.hasOwnProperty(k)) data[k] = extras[k];
  }

  return { data: data };
}
