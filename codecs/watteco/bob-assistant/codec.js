// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco "BoB Assistant" — a machine-condition /
// vibration monitor (KX accelerometer + temperature). Category: motion.
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/watteco/bob-assistant.js, codec id
// "bob-assistant-codec", attributed in NOTICE). The upstream `Decoder` builds a
// flat `data` array of {label, value} pairs plus a `header.type`; we re-derive
// the same wire fields here and emit normalized vocabulary keys. We do NOT
// reuse upstream normalizeUplink / its array output shape.
//
// All frames are on fPort 1. byte0 selects the report type:
//   0x72 / 0x52  Report  — periodic machine-condition summary. Carries the
//                count of alarm reports (NbAlarmReport, byte4) => action.motion.
//                count, temperature, battery percentage, anomaly/vibration
//                metrics.
//   0x61         Alarm   — a discrete vibration/anomaly alarm event =>
//                action.motion.detected = true, plus temperature, vibration
//                level and a 32-bin FFT.
//   0x6c         Learning— baseline-learning frame (no alarm event): temperature,
//                vibration level, learning progress, peak frequency, FFT.
//   0x53         State   — sensor/machine start/stop transition + battery.
//
// Mappings (action.motion is the category anchor):
//   Alarm frame                 -> action.motion.detected = true
//   Report NbAlarmReport (byte4)-> action.motion.count
//   temperature (°C)            -> air.temperature
//   battery percentage          -> batteryPercent (extra; vocab `battery` is V)
//   everything else (anomaly,
//     vibration, FFT, operating
//     time, state, learning)    -> camelCase extras
// Raw spectral/RMS magnitudes are preserved as extras only; the discrete
// alarm event / alarm count is what qualifies this device for `motion`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 1) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 1)'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var t = bytes[0];
  if (t === 0x72 || t === 0x52) {
    return decodeReport(bytes);
  }
  if (t === 0x61) {
    return decodeAlarm(bytes);
  }
  if (t === 0x6c) {
    return decodeLearning(bytes);
  }
  if (t === 0x53) {
    return decodeState(bytes);
  }
  return { errors: ['unsupported report type 0x' + t.toString(16)] };
}

function decodeReport(bytes) {
  if (bytes.length < 27) {
    return { errors: ['truncated Report frame'] };
  }

  // reportperiod: byte6 <= 0x3b is minutes; above that it is encoded seconds.
  var reportperiod;
  if (bytes[6] <= 0x3b) {
    reportperiod = bytes[6];
  } else {
    reportperiod = (bytes[6] - 59) * 60;
  }
  var operatingtime = bytes[2] * reportperiod / 127;
  var totalUnknownBase = operatingtime - bytes[3] * operatingtime / 127;

  var data = {
    // Discrete alarm-report count is the motion anchor for periodic frames.
    action: { motion: { count: bytes[4] } },
    air: { temperature: bytes[5] - 30 },
    batteryPercent: round(bytes[17] * 100 / 127, 2),
    reportType: 'report',
    sensor: 'KX',
    reportLengthMin: reportperiod,
    anomalyLevel: round(bytes[1] * 100 / 127, 2),
    vibrationLevel: round((bytes[8] * 128 + bytes[9] + bytes[10] / 100) / 10 / 121.45, 5),
    peakFrequencyIndex: bytes[11] + 1,
    operatingTime: round(bytes[2] * 2 / 127, 5),
    totalOperatingTimeKnown: round(bytes[3] * operatingtime / 127, 5),
    totalUnknown1020: round(totalUnknownBase, 5),
    totalUnknown2040: round(totalUnknownBase * bytes[13] / 127, 5),
    totalUnknown4060: round(totalUnknownBase * bytes[14] / 127, 5),
    totalUnknown6080: round(totalUnknownBase * bytes[15] / 127, 5),
    totalUnknown80100: round(totalUnknownBase * bytes[16] / 127, 5),
    anomalyLevelTo20Last24H: bytes[18],
    anomalyLevelTo50Last24H: bytes[19],
    anomalyLevelTo80Last24H: bytes[20],
    anomalyLevelTo20Last30D: bytes[21],
    anomalyLevelTo50Last30D: bytes[22],
    anomalyLevelTo80Last30D: bytes[23],
    anomalyLevelTo20Last6Mo: bytes[24],
    anomalyLevelTo50Last6Mo: bytes[25],
    anomalyLevelTo80Last6Mo: bytes[26]
  };
  return { data: data };
}

function decodeAlarm(bytes) {
  if (bytes.length < 40) {
    return { errors: ['truncated Alarm frame'] };
  }
  var vibrationlevel = (bytes[4] * 128 + bytes[5] + bytes[6] / 100) / 10 / 121.45;

  var fft = [];
  var i;
  for (i = 8; i <= 39; i++) {
    fft.push(round(bytes[i] * vibrationlevel / 127, 6));
  }

  var data = {
    // A discrete vibration/anomaly alarm fired.
    action: { motion: { detected: true } },
    air: { temperature: bytes[2] - 30 },
    reportType: 'alarm',
    sensor: 'KX',
    anomalyLevel: round(bytes[1] * 100 / 127, 2),
    vibrationLevel: round(vibrationlevel, 5),
    fft: fft
  };
  return { data: data };
}

function decodeLearning(bytes) {
  if (bytes.length < 40) {
    return { errors: ['truncated Learning frame'] };
  }
  var FREQ_SAMPLING_ACC_LF = 800;
  var vibrationlevel = (bytes[2] * 128 + bytes[3] + bytes[4] / 100) / 10 / 121.45;

  var fft = [];
  var i;
  for (i = 8; i <= 39; i++) {
    fft.push(round(bytes[i] * vibrationlevel / 127, 6));
  }

  var data = {
    // Learning frames carry no alarm event; report no motion.detected.
    air: { temperature: bytes[6] - 30 },
    reportType: 'learning',
    sensor: 'KX',
    learningFromScratch: bytes[7],
    learningPercentage: bytes[1],
    vibrationLevel: round(vibrationlevel, 5),
    peakFrequencyIndex: bytes[5] + 1,
    peakFrequency: round((bytes[5] + 1) * FREQ_SAMPLING_ACC_LF / 256, 5),
    fft: fft
  };
  return { data: data };
}

function decodeState(bytes) {
  if (bytes.length < 3) {
    return { errors: ['truncated State frame'] };
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

  var data = {
    reportType: 'state',
    sensor: 'KX',
    state: state,
    batteryPercent: round(bytes[2] * 100 / 127, 2)
  };
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "bob-assistant";
  }
  return result;
}
