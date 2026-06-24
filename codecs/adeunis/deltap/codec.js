// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Adeunis Delta P differential-pressure
// transmitter (ΔP across two ports, reported in pascals).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Adeunis frame-code + status-byte framing) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/adeunis/deltap_lib.js, attributed in NOTICE). The normalization below is
// authored here; the upstream `decodeUplink` (which nests everything under
// `data.bytes` and never errors) is NOT copied.
//
// The device reports a CALIBRATED differential pressure directly in pascals
// (signed int16; negative = reverse ΔP). No conversion is required — pressure
// values map straight to the vocabulary key `pressure.differential` (Pa).
//
// Frames normalized:
//   0x53 periodic data — one or more signed-int16 ΔP samples in Pa, newest-first
//                        ([t=0, t-1, t-2, ...]). The newest sample maps to the
//                        top-level pressure.differential; older samples go to the
//                        camelCase extra `samples` (newest-first, Pa).
//   0x54 alarm         — current ΔP (Pa) plus a threshold alarmStatus flag.
//   0x55 periodic 0-10 V / 0x56 alarm 0-10 V — the analog 0-10 V product variant
//                        reports a raw transducer voltage in mV, NOT a calibrated
//                        pressure. With no transfer function on the wire it cannot
//                        be converted to Pa, so it is preserved verbatim as the
//                        camelCase extra `voltage` (mV) and produces NO
//                        pressure.differential.
//   0x10 / 0x11 config — sampling/historization configuration (camelCase extras).
//   0x1f / 0x20 / 0x2f / 0x30 / 0x33 / 0x51 / 0x52 — generic Adeunis service
//                        frames (config, downlink ack, keep-alive, register-set
//                        status, digital-input config/alarm). No pressure reading;
//                        exposed as camelCase extras.
//
// The device carries no air temperature and no battery voltage on the wire (only
// a lowBattery status bit), so neither air.temperature nor battery is emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, offset) {
  return (((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)) & 0xffff;
}

function s16be(bytes, offset) {
  var v = u16be(bytes, offset);
  return v & 0x8000 ? v - 0x10000 : v;
}

function u32be(bytes, offset) {
  return (
    ((bytes[offset] & 0xff) * 0x1000000) +
    (((bytes[offset + 1] & 0xff) << 16) |
      ((bytes[offset + 2] & 0xff) << 8) |
      (bytes[offset + 3] & 0xff))
  );
}

// Status byte (payload[1]) common to every Adeunis frame. Bit semantics mirror
// the upstream GenericStatusByteExtParser.
function applyStatus(data, statusByte) {
  data.frameCounter = (statusByte & 0xe0) >> 5;
  data.lowBattery = Boolean(statusByte & 0x02);
  data.configurationDone = Boolean(statusByte & 0x01);
  data.configurationInconsistency = Boolean(statusByte & 0x08);
}

// 0x53 periodic data: repeating signed-int16 ΔP samples (Pa), newest-first.
function decodePeriodic(bytes) {
  var samples = [];
  var offset;
  for (offset = 2; offset + 2 <= bytes.length; offset += 2) {
    samples.push(round(s16be(bytes, offset), 0));
  }

  if (samples.length === 0) {
    return { errors: ['0x53 periodic frame contained no samples'] };
  }

  var data = {
    frameType: '0x53 periodic',
    pressure: { differential: samples[0] }
  };

  applyStatus(data, bytes[1]);

  if (samples.length > 1) {
    data.samples = samples;
  }

  return { data: data };
}

// 0x54 alarm: alarm flag (payload[2]) then a single signed-int16 ΔP (Pa).
function decodeAlarm(bytes) {
  if (bytes.length < 5) {
    return { errors: ['0x54 alarm frame too short'] };
  }

  var data = {
    frameType: '0x54 alarm',
    pressure: { differential: round(s16be(bytes, 3), 0) },
    alarmStatus: bytes[2] ? 'active' : 'inactive'
  };

  applyStatus(data, bytes[1]);

  return { data: data };
}

// 0x55 periodic 0-10 V: repeating signed-int16 transducer voltages (mV),
// newest-first. No calibrated pressure available — voltage only.
function decodeVoltagePeriodic(bytes) {
  var voltages = [];
  var offset;
  for (offset = 2; offset + 2 <= bytes.length; offset += 2) {
    voltages.push(round(s16be(bytes, offset), 0));
  }

  if (voltages.length === 0) {
    return { errors: ['0x55 periodic 0-10 V frame contained no samples'] };
  }

  var data = {
    frameType: '0x55 periodic 0-10 V',
    voltage: voltages.length > 1 ? voltages : voltages[0]
  };

  applyStatus(data, bytes[1]);

  return { data: data };
}

// 0x56 alarm 0-10 V: alarm flag then a single signed-int16 voltage (mV).
function decodeVoltageAlarm(bytes) {
  if (bytes.length < 5) {
    return { errors: ['0x56 alarm 0-10 V frame too short'] };
  }

  var data = {
    frameType: '0x56 alarm 0-10 V',
    voltage: round(s16be(bytes, 3), 0),
    alarmStatus: bytes[2] ? 'active' : 'inactive'
  };

  applyStatus(data, bytes[1]);

  return { data: data };
}

// 0x10 configuration: sampling/historization periods (seconds).
function decodeConfig(bytes) {
  if (bytes.length < 10) {
    return { errors: ['0x10 configuration frame too short'] };
  }
  var sampling = u16be(bytes, 8);
  var samplingBeforeHist = u16be(bytes, 6);
  var histBeforeSending = u16be(bytes, 4);
  var data = {
    frameType: '0x10 configuration',
    transmissionPeriodKeepAliveSec: u16be(bytes, 2) * 10,
    numberOfHistorizationBeforeSending: histBeforeSending,
    numberOfSamplingBeforeHistorization: samplingBeforeHist,
    samplingPeriodSec: sampling * 2,
    calculatedPeriodRecordingSec: sampling * samplingBeforeHist * 2,
    calculatedSendingPeriodSec: sampling * samplingBeforeHist * histBeforeSending * 2
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x11 configuration (0-10 V variant): sampling/historization periods (seconds).
function decodeConfig010(bytes) {
  if (bytes.length < 8) {
    return { errors: ['0x11 configuration frame too short'] };
  }
  var samplingBeforeHist = u16be(bytes, 2);
  var sampling = u16be(bytes, 4);
  var histBeforeSending = u16be(bytes, 6);
  var data = {
    frameType: '0x11 configuration 0-10 V',
    numberOfHistorizationBeforeSending: histBeforeSending,
    numberOfSamplingBeforeHistorization: samplingBeforeHist,
    samplingPeriodSec: sampling * 2,
    calculatedPeriodRecordingSec: samplingBeforeHist * sampling * 2,
    calculatedSendingPeriodSec: samplingBeforeHist * sampling * histBeforeSending * 2
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

function downlinkAckStatusText(value) {
  switch (value) {
    case 1: return 'success';
    case 2: return 'errorGeneric';
    case 3: return 'errorWrongState';
    case 4: return 'errorInvalidRequest';
    default: return 'errorOtherReason';
  }
}

// 0x2f Delta P downlink ack.
function decodeDownlinkAck(bytes) {
  if (bytes.length < 3) {
    return { errors: ['0x2f downlink ack frame too short'] };
  }
  var data = {
    frameType: '0x2f downlink ack',
    requestStatus: downlinkAckStatusText(bytes[2])
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x30 keep-alive: status byte only.
function decodeKeepAlive(bytes) {
  var data = { frameType: '0x30 keep alive' };
  applyStatus(data, bytes[1]);
  return { data: data };
}

function setRegisterStatusText(value) {
  switch (value) {
    case 1: return 'success';
    case 2: return 'successNoUpdate';
    case 3: return 'errorCoherency';
    case 4: return 'errorInvalidRegister';
    case 5: return 'errorInvalidValue';
    case 6: return 'errorTruncatedValue';
    case 7: return 'errorAccesNotAllowed';
    default: return 'errorOtherReason';
  }
}

// 0x33 set register status.
function decodeSetRegister(bytes) {
  if (bytes.length < 5) {
    return { errors: ['0x33 set register status frame too short'] };
  }
  var data = {
    frameType: '0x33 set register status',
    requestStatus: setRegisterStatusText(bytes[2]),
    registerId: u16be(bytes, 3)
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

function digitalInputTypeText(value) {
  switch (value) {
    case 0x0: return 'deactivated';
    case 0x1: return 'highEdge';
    case 0x2: return 'lowEdge';
    case 0x3: return 'bothEdges';
    default: return '';
  }
}

function debouncingPeriodMs(value) {
  var table = [0, 10, 20, 500, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000, 60000, 300000, 600000];
  return value >= 0 && value < table.length ? table[value] : 0;
}

// 0x1f digital input configuration.
function decodeDigitalInputConfig(bytes) {
  if (bytes.length < 8) {
    return { errors: ['0x1f digital input configuration frame too short'] };
  }
  var data = {
    frameType: '0x1f digital input configuration',
    digitalInput1: {
      type: digitalInputTypeText(bytes[2] & 0x0f),
      debouncingPeriodMs: debouncingPeriodMs((bytes[2] & 0xf0) >> 4),
      threshold: u16be(bytes, 3)
    },
    digitalInput2: {
      type: digitalInputTypeText(bytes[5] & 0x0f),
      debouncingPeriodMs: debouncingPeriodMs((bytes[5] & 0xf0) >> 4),
      threshold: u16be(bytes, 6)
    }
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x20 LoRa network configuration.
function decodeNetworkConfig(bytes) {
  if (bytes.length !== 4) {
    return { errors: ['0x20 configuration frame has unsupported length ' + bytes.length] };
  }
  var data = {
    frameType: '0x20 configuration',
    loraAdr: Boolean(bytes[2] & 0x01),
    loraProvisioningMode: bytes[3] === 0 ? 'ABP' : 'OTAA',
    loraDutycycle: bytes[2] & 0x04 ? 'activated' : 'deactivated',
    loraClassMode: bytes[2] & 0x20 ? 'CLASS C' : 'CLASS A'
  };
  applyStatus(data, bytes[1]);
  return { data: data };
}

// 0x51 / 0x52 digital input alarm (counter-based, no pressure reading).
function decodeDigitalInputAlarm(bytes, frameType) {
  if (bytes.length < 9) {
    return { errors: [frameType + ' frame too short'] };
  }
  var data = {
    frameType: frameType,
    state: {
      previousFrame: Boolean((bytes[2] >> 1) & 1),
      current: Boolean(bytes[2] & 1)
    },
    counter: {
      global: u32be(bytes, 3),
      instantaneous: u16be(bytes, 7)
    }
  };
  // Timestamp present when status bit 0x04 is set (epoch offset 2013-01-01).
  if (bytes[1] & 0x04 && bytes.length >= 13) {
    var epoch = u32be(bytes, 9) + 1356998400;
    data.timestamp = new Date(epoch * 1000).toISOString().replace('Z', '');
  }
  applyStatus(data, bytes[1]);
  return { data: data };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var frameCode = bytes[0];
  switch (frameCode) {
    case 0x53: return decodePeriodic(bytes);
    case 0x54: return decodeAlarm(bytes);
    case 0x55: return decodeVoltagePeriodic(bytes);
    case 0x56: return decodeVoltageAlarm(bytes);
    case 0x10: return decodeConfig(bytes);
    case 0x11: return decodeConfig010(bytes);
    case 0x1f: return decodeDigitalInputConfig(bytes);
    case 0x20: return decodeNetworkConfig(bytes);
    case 0x2f: return decodeDownlinkAck(bytes);
    case 0x30: return decodeKeepAlive(bytes);
    case 0x33: return decodeSetRegister(bytes);
    case 0x51: return decodeDigitalInputAlarm(bytes, '0x51 digital input 1 alarm');
    case 0x52: return decodeDigitalInputAlarm(bytes, '0x52 digital input 2 alarm');
    default:
      return {
        errors: [
          'unsupported frame code 0x' + frameCode.toString(16) +
            ' (Adeunis Delta P frames 0x10, 0x11, 0x1f, 0x20, 0x2f, 0x30, 0x33, ' +
            '0x51, 0x52, 0x53, 0x54, 0x55, 0x56 are normalized)'
        ]
      };
  }
}
