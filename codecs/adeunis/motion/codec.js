// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/motion (Adeunis MOTION — PIR presence
// detector with luminosity sensing and digital inputs).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/adeunis/motion_lib.js, attributed in
// NOTICE) — wire format only. Normalization is authored here; upstream
// normalizeUplink is NOT copied.
//
// Frame map (byte 0 = frame code, byte 1 = generic status byte):
//   0x4e Motion data           -> action.motion.count (globalCounterValue)
//   0x4f Motion presence alarm -> action.motion.count + detected (alarm => presence)
//   0x5c Motion data           -> action.motion.detected (presenceDetectedWhenSending)
//   0x5d Motion presence alarm -> action.motion.detected (alarmStatus === active)
// Status byte low-battery flag -> extra `lowBattery` (boolean; device reports no
// battery voltage, so `battery` (V) is not emitted). Other device-specific data
// (luminosity, presence sample %, frame counter, config flags, alarm counters)
// -> camelCase extras.

function readUInt16BE(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function readInt16BE(bytes, offset) {
  var a = (bytes[offset] << 8) | bytes[offset + 1];
  if ((a & 0x8000) > 0) {
    return a - 0x10000;
  }
  return a;
}

function parseStatusByte(b) {
  return {
    frameCounter: (b & 0xe0) >> 5,
    lowBattery: Boolean(b & 0x02),
    configurationDone: Boolean(b & 0x01),
    configurationInconsistency: Boolean(b & 0x08)
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var frameCode = bytes[0];
  var status = parseStatusByte(bytes[1]);

  var data = {
    action: { motion: {} },
    frameCounter: status.frameCounter,
    lowBattery: status.lowBattery,
    configurationDone: status.configurationDone,
    configurationInconsistency: status.configurationInconsistency
  };

  var offset, presenceSamples, luminositySamples, counterSamples;

  if (frameCode === 0x5c) {
    // 0x5c Motion data: presence detected flag + presence/luminosity samples.
    if (bytes.length < 3) {
      return { errors: ['0x5c payload too short'] };
    }
    data.action.motion.detected = Boolean(bytes[2]);
    presenceSamples = [];
    luminositySamples = [];
    for (offset = 3; offset + 1 < bytes.length; offset += 2) {
      presenceSamples.push(bytes[offset]);
      luminositySamples.push(bytes[offset + 1]);
    }
    data.presencePercent = presenceSamples;
    data.luminosityPercent = luminositySamples;
    return { data: data };
  }

  if (frameCode === 0x4e) {
    // 0x4e Motion data: global motion counter + per-sample counters/luminosity.
    if (bytes.length < 4) {
      return { errors: ['0x4e payload too short'] };
    }
    data.action.motion.count = readUInt16BE(bytes, 2);
    counterSamples = [];
    luminositySamples = [];
    for (offset = 4; offset + 2 < bytes.length; offset += 3) {
      counterSamples.push(readInt16BE(bytes, offset));
      luminositySamples.push(bytes[offset + 2]);
    }
    data.counterSamples = counterSamples;
    data.luminosityPercent = luminositySamples;
    return { data: data };
  }

  if (frameCode === 0x4f) {
    // 0x4f Motion presence alarm: alarm implies presence; global counter value.
    if (bytes.length < 6) {
      return { errors: ['0x4f payload too short'] };
    }
    data.action.motion.detected = true;
    data.action.motion.count = readUInt16BE(bytes, 2);
    data.alarmCounterValue = readUInt16BE(bytes, 4);
    return { data: data };
  }

  if (frameCode === 0x5d) {
    // 0x5d Motion presence alarm: alarmStatus active => presence detected.
    if (bytes.length < 4) {
      return { errors: ['0x5d payload too short'] };
    }
    data.action.motion.detected = Boolean(bytes[2]);
    data.alarmLuminosityPercent = bytes[3];
    return { data: data };
  }

  return { errors: ['unsupported frame code 0x' + frameCode.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "motion";
  }
  return result;
}
