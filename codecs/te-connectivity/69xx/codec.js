// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TE Connectivity 69XXN wireless pressure
// transducer (single-point pressure + temperature + battery; fPort 10).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/te-connectivity/universal_decoder.js,
// functions DecodeSinglePoint / getDevtype / getDevstat / arrayConverter /
// arrayToFloat, attributed in NOTICE). The fPort-10 single-point frame layout
// (big-endian uint16 devtype at [0..1], counter at [2..3], status byte [4],
// battery byte [5], signed int16 temperature/100 at [6..7], and the IEEE-754
// big-endian float32 main value at [8..11]) is reproduced faithfully from that
// decoder; the normalization to the shared vocabulary is authored here (the
// upstream te_decoder / decode object is NOT copied).
//
// Frame (fPort 10, single-point):
//   bytes[0..1]  devtype, uint16 BE. High nibbles encode platform/sensor/
//                wireless/output; we require Sensor=Pressure (0x_3__) so the
//                main value is a calibrated pressure, and Output=Float so it is
//                an IEEE-754 float32 in Bar (the unit nibble for pressure).
//   bytes[2..3]  message counter, uint16 BE
//   bytes[4]     device-status bitfield (0x00 = ok)
//   bytes[5]     battery (percent, 0..100; device reports %, not volts)
//   bytes[6..7]  temperature, int16 BE, hundredths of deg C
//   bytes[8..11] main value, float32 BE; for a pressure/float device this is the
//                line pressure in Bar.
//
// Mapping to the shared vocabulary:
//   main value (Bar) -> pressure.gauge (kPa, Bar x 100). The 69XXN is a line/
//                       process gauge transducer (relative to ambient), so the
//                       calibrated reading maps to pressure.gauge.
//   temperature      -> air.temperature (deg C)
//   battery percent  -> camelCase extra `batteryPercent` (device reports %, not V)
//   device status    -> camelCase extra `deviceStatus` (string 'ok' or flag list)
//   counter          -> camelCase extra `messageCount`
//   devtype decode   -> camelCase extra `deviceType`
//
// Banned in the TTN/ChirpStack console sandbox and therefore avoided here:
//   require, import/export, module.exports, exports., process, Buffer,
//   globalThis, eval, new Function, timers, console, fetch, async/await,
//   Promise, optional chaining (?.), nullish (??), spread/rest (...), BigInt,
//   private (#) fields, static blocks. ES5-style only.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function uint16BE(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) & 0xffff;
}

function int16BE(bytes, offset) {
  var v = uint16BE(bytes, offset);
  return v >= 0x8000 ? v - 0x10000 : v;
}

// IEEE-754 single-precision, big-endian, from four bytes. Math-only so it is
// console-safe (no DataView/ArrayBuffer reliance).
function float32BE(bytes, offset) {
  var b0 = bytes[offset];
  var b1 = bytes[offset + 1];
  var b2 = bytes[offset + 2];
  var b3 = bytes[offset + 3];
  var sign = b0 & 0x80 ? -1 : 1;
  var exponent = ((b0 & 0x7f) << 1) | (b1 >> 7);
  var mantissa = ((b1 & 0x7f) << 16) | (b2 << 8) | b3;
  if (exponent === 0) {
    if (mantissa === 0) {
      return sign * 0;
    }
    return sign * mantissa * Math.pow(2, -149);
  }
  if (exponent === 0xff) {
    return mantissa === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + mantissa * Math.pow(2, -23)) * Math.pow(2, exponent - 127);
}

function decodeDevType(u16) {
  var sensor = (u16 >> 8) & 0x0f;
  var output = u16 & 0x0f;
  var platform = (u16 >> 12) & 0x0f;
  var wireless = (u16 >> 4) & 0x0f;
  var sensorDict = { 0: 'Error', 1: 'Vibration', 2: 'Temperature', 3: 'Pressure', 4: 'Humidity' };
  var unitDict = { 0: 'Error', 1: 'g', 2: 'degC', 3: 'Bar', 4: '%' };
  var wirelessDict = { 0: 'Error', 1: 'BLE', 2: 'BLE/LoRaWAN' };
  var outputDict = { 0: 'Error', 1: 'Float', 2: 'Integer' };
  var platformDict = { 0: 'Error', 1: 'Platform_21' };
  return {
    platform: platformDict[platform] || 'Unknown',
    sensor: sensorDict[sensor] || 'Unknown',
    unit: unitDict[sensor] || 'Unknown',
    wireless: wirelessDict[wireless] || 'Unknown',
    output: outputDict[output] || 'Unknown',
    sensorCode: sensor,
    outputCode: output
  };
}

function decodeDevStatus(b) {
  if (b === 0x00) {
    return 'ok';
  }
  var dict = { 7: 'SnsErr', 6: 'CfgErr', 5: 'MiscErr', 4: 'Condition', 3: 'PrelPhase' };
  var flags = [];
  for (var i = 7; i >= 3; i--) {
    if (((b >> i) & 0x01) === 1) {
      flags.push(dict[i]);
    }
  }
  return flags;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 10) {
    return { errors: ['unsupported fPort ' + fPort + ': only the 69XXN single-point frame (fPort 10) is normalized'] };
  }
  if (!bytes || bytes.length < 12) {
    return { errors: ['payload too short: 69XXN single-point frame needs at least 12 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var devType = decodeDevType(uint16BE(bytes, 0));

  // Only the pressure sensor with a float main value yields a calibrated
  // pressure in engineering units (Bar). Anything else is out of scope here.
  if (devType.sensorCode !== 3) {
    return { errors: ['unsupported device type: 69XXN normalization expects a Pressure sensor frame, got sensor=' + devType.sensor] };
  }
  if (devType.outputCode !== 1) {
    return { errors: ['unsupported output format: 69XXN pressure normalization expects a Float (Bar) main value, got output=' + devType.output] };
  }

  var data = {};
  var warnings = [];

  data.messageCount = uint16BE(bytes, 2);
  data.deviceStatus = decodeDevStatus(bytes[4]);
  data.batteryPercent = bytes[5];

  data.air = { temperature: round(int16BE(bytes, 6) / 100.0, 2) };

  var bar = float32BE(bytes, 8);
  if (isNaN(bar) || !isFinite(bar)) {
    warnings.push('pressure value is not a finite float (sensor error)');
  } else {
    // Bar -> kPa: x 100. Gauge (relative to ambient) line pressure.
    data.pressure = { gauge: round(bar * 100, 3) };
  }

  data.deviceType = {
    platform: devType.platform,
    sensor: devType.sensor,
    unit: devType.unit,
    wireless: devType.wireless,
    output: devType.output
  };

  var out = { data: data };
  if (warnings.length > 0) {
    out.warnings = warnings;
  }
  return out;
}
