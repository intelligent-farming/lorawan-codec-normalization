// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Decentlab DL-IAM (Indoor Ambiance Monitor
// including CO2, TVOC and Motion Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Decentlab protocol v2: version byte, 16-bit device id, 16-bit sensor
// flags bitmap, then per-flagged-sensor blocks of 16-bit big-endian words)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-iam.js, attributed in
// NOTICE).
//
// Decentlab reports "Battery voltage" already in volts, so it maps directly to
// the vocabulary's `battery` field. Barometric pressure is reported in Pa;
// the vocabulary's `air.pressure` is hPa, so it is divided by 100. Sensor
// readings the vocabulary does not model (visible/infrared light channels, CO2
// sensor status, raw IR reading, total VOC) are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short: need at least 5 header bytes'] };
  }

  var version = bytes[0];
  if (version !== 2) {
    return { errors: ["protocol version " + version + " doesn't match v2"] };
  }

  var flags = u16be(bytes[3], bytes[4]);

  // Word counts per sensor block, in flag-bit order (LSB first), mirroring the
  // upstream SENSORS table.
  var lengths = [1, 2, 1, 2, 3, 1, 1];

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
  var air = {};
  var hasAir = false;

  // bit0: battery voltage (V, already volts)
  if (words[0]) {
    data.battery = round(words[0][0] / 1000, 3);
  }

  // bit1: air temperature (°C) and relative humidity (%)
  if (words[1]) {
    air.temperature = round(175 * words[1][0] / 65535 - 45, 2);
    air.relativeHumidity = round(100 * words[1][1] / 65535, 2);
    hasAir = true;
  }

  // bit2: barometric pressure (upstream Pa -> hPa)
  if (words[2]) {
    air.pressure = round(words[2][0] * 2 / 100, 2);
    hasAir = true;
  }

  // bit3: ambient light channels + computed illuminance (lux)
  if (words[3]) {
    var visIr = words[3][0];
    var ir = words[3][1];
    var lux = Math.max(Math.max(1.0 * visIr - 1.64 * ir, 0.59 * visIr - 0.86 * ir), 0) * 1.5504;
    air.lightIntensity = round(lux, 2);
    data.ambientLightVisibleInfrared = visIr;
    data.ambientLightInfrared = ir;
    hasAir = true;
  }

  // bit4: CO2 concentration (ppm) + status + raw IR reading
  if (words[4]) {
    air.co2 = words[4][0] - 32768;
    data.co2SensorStatus = words[4][1];
    data.rawIrReading = words[4][2];
    hasAir = true;
  }

  // bit5: activity counter -> motion count + detected flag
  if (words[5]) {
    var count = words[5][0];
    data.action = { motion: { count: count, detected: count > 0 } };
  }

  // bit6: total VOC (ppb) -> camelCase extra (no vocabulary key)
  if (words[6]) {
    data.totalVoc = words[6][0];
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
