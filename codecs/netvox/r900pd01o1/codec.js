// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900PD01O1, data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900pd01.js, shared by
// R900PD01 and R900PD01O1, attributed in NOTICE). Author the normalization here;
// do NOT copy upstream normalizeUplink.
//
// R900PD01O1 is the dry-contact-output sibling of R900PD01: same water-quality
// probe frame (pH / turbidity / residual chlorine + per-parameter temperatures)
// plus an addressable dry-contact relay output whose state is read back over the
// config channel.
//
// fPort 22: bytes[0] frame version, bytes[1..2] 16-bit big-endian device type
// (0x010E == 270 == R900PD01O1), bytes[3] report-type discriminator. reportType
// 0x00 is a device-info/startup frame (sw/hw version + datecode), carries no
// measurement -> error. For a status frame:
//   bytes[4..5]   pH in 0.01 pH                        -> water.ph
//   bytes[6..7]   temperature-with-pH in 0.01 C (two's complement)
//                 -> water.temperature.current (canonical) + extra temperatureWithPh
//   bytes[8..9]   turbidity in 0.1 NTU                  -> water.turbidity
//   bytes[10..11] temperature-with-turbidity in 0.01 C -> extra temperatureWithNtu
//   bytes[12..13] residual chlorine in 0.01 mg/L        -> water.residualChlorine
//   bytes[14..15] 10-bit threshold-alarm bitmap         -> camelCase extras
//   bytes[16]     shock/tamper alarm (0 == none)        -> extra tamperAlarm
//
// fPort 23: config responses. The ReadConfigDryContactPointOut response (cmd
// 0x86 == 134) carries the relay output configuration (type + pulse time + bound
// alarm mask + which output channel) -> surfaced as the camelCase extra
// dryContactOut. Other fPort 23 responses are acks with no measurement -> error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeTemperature(hi, lo) {
  var raw = (hi << 8) | lo;
  if (raw & 0x8000) {
    raw = raw - 0x10000;
  }
  return round(raw / 100, 2);
}

function decodeStatus(bytes) {
  if (bytes.length < 17) {
    return { errors: ['expected at least 17 bytes for status frame, got ' + bytes.length] };
  }

  var data = {};
  var water = {};

  // Bytes 4..5: pH in 0.01 pH.
  water.ph = round(((bytes[4] << 8) | bytes[5]) / 100, 2);
  // Bytes 8..9: turbidity in 0.1 NTU.
  water.turbidity = round(((bytes[8] << 8) | bytes[9]) / 10, 1);
  // Bytes 12..13: residual chlorine in 0.01 mg/L.
  water.residualChlorine = round(((bytes[12] << 8) | bytes[13]) / 100, 2);

  // Bytes 6..7: temperature measured with the pH probe -> canonical water temp.
  var tempPh = decodeTemperature(bytes[6], bytes[7]);
  // Bytes 10..11: temperature measured with the turbidity probe.
  var tempNtu = decodeTemperature(bytes[10], bytes[11]);
  water.temperature = { current: tempPh };
  data.water = water;

  // Per-parameter temperatures preserved as camelCase extras.
  data.temperatureWithPh = tempPh;
  data.temperatureWithNtu = tempNtu;

  // Bytes 14..15: 10-bit threshold-alarm bitmap (big-endian). Categorical extras.
  var flags = (bytes[14] << 8) | bytes[15];
  data.lowPhAlarm = flags & 0x01 ? true : false;
  data.highPhAlarm = flags >> 1 & 0x01 ? true : false;
  data.lowTurbidityAlarm = flags >> 2 & 0x01 ? true : false;
  data.highTurbidityAlarm = flags >> 3 & 0x01 ? true : false;
  data.lowResidualChlorineAlarm = flags >> 4 & 0x01 ? true : false;
  data.highResidualChlorineAlarm = flags >> 5 & 0x01 ? true : false;
  data.lowTemperatureWithPhAlarm = flags >> 6 & 0x01 ? true : false;
  data.highTemperatureWithPhAlarm = flags >> 7 & 0x01 ? true : false;
  data.lowTemperatureWithNtuAlarm = flags >> 8 & 0x01 ? true : false;
  data.highTemperatureWithNtuAlarm = flags >> 9 & 0x01 ? true : false;

  // Byte 16: shock/tamper alarm.
  data.tamperAlarm = bytes[16] !== 0x00;

  return { data: data };
}

function decodeConfig(bytes) {
  if (bytes.length < 3) {
    return { errors: ['expected at least 3 bytes for config frame, got ' + bytes.length] };
  }

  // Only the ReadConfigDryContactPointOut response (cmd 0x86 == 134) carries a
  // state worth surfacing. Everything else on fPort 23 is an ack with no
  // measurement.
  if (bytes[0] !== 0x86) {
    return { errors: ['config response (no measurement)'] };
  }
  if (bytes.length < 8) {
    return { errors: ['expected at least 8 bytes for dry-contact config, got ' + bytes.length] };
  }

  var out = {};
  if (bytes[3] === 0x00) {
    out.type = 'NormallyLowLevel';
  } else if (bytes[3] === 0x01) {
    out.type = 'NormallyHighLevel';
  }
  out.pulseTimeSeconds = bytes[4];

  var flags = (bytes[5] << 8) | bytes[6];
  out.boundAlarms = {
    lowPh: flags & 0x01 ? true : false,
    highPh: flags >> 1 & 0x01 ? true : false,
    lowTurbidity: flags >> 2 & 0x01 ? true : false,
    highTurbidity: flags >> 3 & 0x01 ? true : false,
    lowResidualChlorine: flags >> 4 & 0x01 ? true : false,
    highResidualChlorine: flags >> 5 & 0x01 ? true : false,
    lowTemperatureWithPh: flags >> 6 & 0x01 ? true : false,
    highTemperatureWithPh: flags >> 7 & 0x01 ? true : false,
    lowTemperatureWithNtu: flags >> 8 & 0x01 ? true : false,
    highTemperatureWithNtu: flags >> 9 & 0x01 ? true : false
  };

  if (bytes[7] === 0x00) {
    out.channel = 'Channel1';
  } else if (bytes[7] === 0x01) {
    out.channel = 'Channel2';
  }

  return { data: { dryContactOut: out } };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 22) {
    if (bytes.length < 4) {
      return { errors: ['expected at least 4 bytes, got ' + bytes.length] };
    }
    if (bytes[3] === 0x00) {
      return { errors: ['device info frame (no measurement)'] };
    }
    return decodeStatus(bytes);
  }

  if (input.fPort === 23) {
    return decodeConfig(bytes);
  }

  return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22 data report or 23 config)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900pd01o1";
  }
  return result;
}
