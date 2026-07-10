// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for smartrural/grain-probe-01 (Grain Probe): a
// two-channel grain/silo temperature probe. It is a standalone temperature
// device (its sole sensor is temperature).
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/smartrural/grain-probe.js, referenced
// via grain-probe-codec.yaml, attributed in NOTICE). Normalization authored
// here; upstream output (with its `debug`/`Systimestamp` nesting) is NOT copied.
//
// Wire format (all telemetry on fPort 2):
//   bytes[0..1]  battery: ((hi<<8|lo) & 0x3FFF) / 1000  -> volts (already V)
//   bytes[2]     high nibble bit6 = poll flag; low nibble = Ext (sensor mode):
//                  0x01 -> two temperature channels, hundredths of a degree
//                          (signed16(bytes[3],bytes[4]) / 100  -> °C)
//                  0x02 -> two temperature channels, tenths of a degree (/10)
//                  0x03 -> raw channel resistance (Ω), NOT a temperature
//   bytes[3..6]  two signed-16 big-endian channel values
//   bytes[7..10] Systimestamp: uint32 unix epoch seconds
//
// Normalization: standalone temperature probe -> channel 1 is the top-level
// `temperature` (°C); channel 2 and the sensor mode / timestamp are extras.
// battery is already volts (÷1000 upstream). Resistance mode (Ext 0x03) reports
// no temperature, so it is surfaced as an error (no confident temperature).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  if (v & 0x8000) {
    v -= 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 2) {
    return { errors: ['unknown FPort (expected 2)'] };
  }
  var bytes = input.bytes;
  if (!bytes || bytes.length < 11) {
    return { errors: ['payload too short (expected 11 bytes)'] };
  }

  var pollStatus = (bytes[2] & 0x40) >> 6;
  if (pollStatus !== 0) {
    return { errors: ['poll-request acknowledgement frame carries no measurement'] };
  }

  var ext = bytes[2] & 0x0f;
  var battery = round((((bytes[0] << 8) | bytes[1]) & 0x3fff) / 1000, 3);
  var scale;
  if (ext === 0x01) {
    scale = 100;
  } else if (ext === 0x02) {
    scale = 10;
  } else {
    return { errors: ['sensor mode 0x' + ext.toString(16) + ' reports no temperature'] };
  }

  var t1 = round(signed16(bytes[3], bytes[4]) / scale, ext === 0x01 ? 2 : 1);
  var t2 = round(signed16(bytes[5], bytes[6]) / scale, ext === 0x01 ? 2 : 1);

  var data = {};
  data.temperature = t1;
  data.temperature2 = t2;
  data.temperatures = [t1, t2];
  data.battery = battery;
  data.sensorMode = ext;
  data.deviceTime = ((bytes[7] << 24) | (bytes[8] << 16) | (bytes[9] << 8) | bytes[10]) >>> 0;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "smartrural";
    result.data.model = "grain-probe-01";
  }
  return result;
}
