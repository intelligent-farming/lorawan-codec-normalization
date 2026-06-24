// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for nke-watteco/bob-assistant (BoB Assistant —
// machine-condition / vibration monitor, KX accelerometer).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/nke-watteco/bob-assistant.js,
// attributed in NOTICE). Do NOT copy upstream normalizeUplink.
//
// Ported from the upstream Decoder(bytes, port): all uplinks are on fPort 1 and
// the first byte selects the report type. Discrete machine-condition events map
// to the shared vocabulary; raw vibration magnitudes / spectra are extras:
//   0x72 / 0x52 Report  -> action.motion.count (NbAlarmReport, byte 4),
//                          air.temperature (byte5 - 30), batteryPercent,
//                          anomalyLevel / vibrationLevel / time buckets (extras)
//   0x61        Alarm   -> action.motion.detected = true (a vibration alarm),
//                          air.temperature (byte2 - 30), vibrationLevel,
//                          anomalyLevel, fft[] (extras)
//   0x6c        Learning-> air.temperature (byte6 - 30), learning*/peak*/fft (extras)
//   0x53        State   -> deviceState (extra), batteryPercent
// The upstream codec stamps each value with the decode-time wall clock; we omit
// that (no real timestamp is in the payload, and the sandbox forbids it).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 1) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 1)'] };
  }
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var type = bytes[0];
  var data = {};
  var i;

  // Report type (periodic machine-condition summary).
  if (type === 0x72 || type === 0x52) {
    if (bytes.length < 27) {
      return { errors: ['report payload too short'] };
    }

    var reportperiod;
    if (bytes[6] <= 0x3b) {
      reportperiod = bytes[6];
    } else {
      reportperiod = (bytes[6] - 59) * 60;
    }
    var operatingtime = (bytes[2] * reportperiod) / 127;
    var knownFactor = operatingtime - (bytes[3] * operatingtime) / 127;

    // Discrete event count: number of alarm reports since last uplink.
    data.action = { motion: { count: bytes[4] } };
    data.air = { temperature: bytes[5] - 30 };
    data.batteryPercent = round((bytes[17] * 100) / 127, 1);

    data.anomalyLevel = round((bytes[1] * 100) / 127, 2);
    data.vibrationLevel = round((bytes[8] * 128 + bytes[9] + bytes[10] / 100) / 10 / 121.45, 4);
    data.peakFrequencyIndex = bytes[11] + 1;
    data.operatingTime = round((bytes[2] * 2) / 127, 4);
    data.totalOperatingTimeKnown = round((bytes[3] * operatingtime) / 127, 4);
    data.totalUnknown1020 = round(knownFactor, 4);
    data.totalUnknown2040 = round((knownFactor * bytes[13]) / 127, 4);
    data.totalUnknown4060 = round((knownFactor * bytes[14]) / 127, 4);
    data.totalUnknown6080 = round((knownFactor * bytes[15]) / 127, 4);
    data.totalUnknown80100 = round((knownFactor * bytes[16]) / 127, 4);
    data.anomalyLevelTo20Last24H = bytes[18];
    data.anomalyLevelTo50Last24H = bytes[19];
    data.anomalyLevelTo80Last24H = bytes[20];
    data.anomalyLevelTo20Last30D = bytes[21];
    data.anomalyLevelTo50Last30D = bytes[22];
    data.anomalyLevelTo80Last30D = bytes[23];
    data.anomalyLevelTo20Last6Mo = bytes[24];
    data.anomalyLevelTo50Last6Mo = bytes[25];
    data.anomalyLevelTo80Last6Mo = bytes[26];
    data.reportLength = reportperiod;

    return { data: data };
  }

  // Alarm type (a discrete vibration alarm event).
  if (type === 0x61) {
    if (bytes.length < 40) {
      return { errors: ['alarm payload too short'] };
    }
    var alarmVibration = (bytes[4] * 128 + bytes[5] + bytes[6] / 100) / 10 / 121.45;

    data.action = { motion: { detected: true } };
    data.air = { temperature: bytes[2] - 30 };
    data.vibrationLevel = round(alarmVibration, 4);
    data.anomalyLevel = round((bytes[1] * 100) / 127, 2);

    var afft = [];
    for (i = 8; i <= 39; i++) {
      afft.push(round((bytes[i] * alarmVibration) / 127, 6));
    }
    data.fft = afft;

    return { data: data };
  }

  // Learning type.
  if (type === 0x6c) {
    if (bytes.length < 40) {
      return { errors: ['learning payload too short'] };
    }
    var FREQ_SAMPLING_ACC_LF = 800;
    var learnVibration = (bytes[2] * 128 + bytes[3] + bytes[4] / 100) / 10 / 121.45;

    data.air = { temperature: bytes[6] - 30 };
    data.learningFromScratch = bytes[7];
    data.learningPercentage = bytes[1];
    data.vibrationLevel = round(learnVibration, 4);
    data.peakFrequencyIndex = bytes[5] + 1;
    data.peakFrequency = round(((bytes[5] + 1) * FREQ_SAMPLING_ACC_LF) / 256, 4);

    var lfft = [];
    for (i = 8; i <= 39; i++) {
      lfft.push(round((bytes[i] * learnVibration) / 127, 6));
    }
    data.fft = lfft;

    return { data: data };
  }

  // State type (sensor / machine start-stop transitions).
  if (type === 0x53) {
    if (bytes.length < 3) {
      return { errors: ['state payload too short'] };
    }
    var state;
    if (bytes[1] === 100) {
      state = 'Sensor start';
    } else if (bytes[1] === 101) {
      state = 'Sensor stop';
    } else if (bytes[1] === 125) {
      state = 'Machine stop';
    } else if (bytes[1] === 126) {
      state = 'Machine start';
    } else {
      state = 'Unknown';
    }
    data.deviceState = state;
    data.batteryPercent = round((bytes[2] * 100) / 127, 1);

    return { data: data };
  }

  return { errors: ['unrecognized report type 0x' + type.toString(16)] };
}
