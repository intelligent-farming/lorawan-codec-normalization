// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Adeunis Breath indoor air-quality sensor
// (particulate matter PM1.0 / PM2.5 / PM10 + total volatile organic compounds).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Adeunis frame-code + status-byte framing) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/adeunis/breath_lib.js, attributed in NOTICE). The normalization below is
// authored here; the upstream `decodeUplink` (which nests everything under
// `data.bytes` and never errors) is NOT copied.
//
// Frames normalized:
//   0x6d periodic data  — one or more [tvoc, pm10, pm25, pm1] samples, newest-
//                         first ([t=0, t-1, t-2, ...]). The newest sample is
//                         mapped to the top-level air.* PM keys; older samples
//                         go to the camelCase extra `samples` (newest-first).
//   0x6e alarm          — current [tvoc, pm10, pm25, pm1] reading plus per-channel
//                         alarm flags (camelCase extra `alarms`).
//   0x30 daily frame    — per-channel min/max/average aggregates over the day.
//                         Aggregates carry no instantaneous reading, so they are
//                         exposed only as the camelCase extra `daily`.
//
// IMPORTANT — TVOC units: the Breath reports TVOC as a *mass concentration* in
// µg/m³. The vocabulary `air.tvoc` is ppb (a mixing ratio); the µg/m³ -> ppb
// conversion is compound-specific and the device does not report it, so the
// reading is NOT placed in air.tvoc. It is preserved verbatim as the camelCase
// extra `tvocMassConcentration` (µg/m³).

function u16be(bytes, offset) {
  return (((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)) & 0xffff;
}

// Status byte (payload[1]) common to every Breath frame. Bit semantics mirror
// the upstream GenericStatusByteParser / BreathStatusByteParser (incl. the
// upstream sensorError mask of 0x16, kept verbatim for fidelity).
function decodeStatus(status) {
  return {
    frameCounter: (status & 0xe0) >> 5,
    lowBattery: Boolean(status & 0x02),
    configurationDone: Boolean(status & 0x01),
    configurationInconsistency: Boolean(status & 0x08),
    sensorError: Boolean(status & 0x16)
  };
}

function applyStatus(data, statusByte) {
  var status = decodeStatus(statusByte);
  data.frameCounter = status.frameCounter;
  data.lowBattery = status.lowBattery;
  data.configurationDone = status.configurationDone;
  data.configurationInconsistency = status.configurationInconsistency;
  data.sensorError = status.sensorError;
}

// 0x6d periodic data: repeating 8-byte groups [tvoc, pm10, pm25, pm1] (u16be).
function decodePeriodic(bytes) {
  var samples = [];
  var offset;
  for (offset = 2; offset + 8 <= bytes.length; offset += 8) {
    samples.push({
      pm1_0: u16be(bytes, offset + 6),
      pm2_5: u16be(bytes, offset + 4),
      pm10: u16be(bytes, offset + 2),
      tvocMassConcentration: u16be(bytes, offset)
    });
  }

  if (samples.length === 0) {
    return { errors: ['0x6d periodic frame contained no samples'] };
  }

  var current = samples[0];
  var data = {
    frameType: '0x6d periodic',
    air: {
      pm1_0: current.pm1_0,
      pm2_5: current.pm2_5,
      pm10: current.pm10
    },
    tvocMassConcentration: current.tvocMassConcentration
  };

  applyStatus(data, bytes[1]);

  if (samples.length > 1) {
    data.samples = samples;
  }

  return { data: data };
}

// 0x6e alarm: per-channel alarm flags in payload[2], then [tvoc, pm10, pm25, pm1]
// (u16be) at offsets 3, 5, 7, 9.
function decodeAlarm(bytes) {
  if (bytes.length < 11) {
    return { errors: ['0x6e alarm frame too short'] };
  }

  var flags = bytes[2];
  var data = {
    frameType: '0x6e alarm',
    air: {
      pm1_0: u16be(bytes, 9),
      pm2_5: u16be(bytes, 7),
      pm10: u16be(bytes, 5)
    },
    tvocMassConcentration: u16be(bytes, 3),
    alarms: {
      pm1_0: Boolean(flags & 0x08),
      pm2_5: Boolean(flags & 0x04),
      pm10: Boolean(flags & 0x02),
      tvocMassConcentration: Boolean(flags & 0x01)
    }
  };

  applyStatus(data, bytes[1]);

  return { data: data };
}

// One daily channel: min/max/average (µg/m³) and optional duration (min).
function dailyChannel(bytes, base, withDuration) {
  var channel = {
    min: u16be(bytes, base),
    max: u16be(bytes, base + 2),
    average: u16be(bytes, base + 4)
  };
  if (withDuration) {
    channel.durationMin = u16be(bytes, base + 6);
  }
  return channel;
}

// 0x30 daily frame: per-channel aggregates. The long form (>= 11 payload bytes)
// carries min/max/average/duration per channel; the short form carries only a
// per-channel max. No instantaneous reading is present, so nothing maps to air.*.
function decodeDaily(bytes) {
  var daily;
  if (bytes.length >= 11) {
    daily = {
      tvocMassConcentration: dailyChannel(bytes, 2, true),
      pm10: dailyChannel(bytes, 10, true),
      pm2_5: dailyChannel(bytes, 18, true),
      pm1_0: dailyChannel(bytes, 26, false)
    };
  } else {
    if (bytes.length < 10) {
      return { errors: ['0x30 daily frame too short'] };
    }
    daily = {
      tvocMassConcentration: { max: u16be(bytes, 2) },
      pm10: { max: u16be(bytes, 4) },
      pm2_5: { max: u16be(bytes, 6) },
      pm1_0: { max: u16be(bytes, 8) }
    };
  }

  var data = {
    frameType: '0x30 daily',
    daily: daily
  };

  applyStatus(data, bytes[1]);

  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var frameCode = bytes[0];
  if (frameCode === 0x6d) {
    return decodePeriodic(bytes);
  }
  if (frameCode === 0x6e) {
    return decodeAlarm(bytes);
  }
  if (frameCode === 0x30) {
    return decodeDaily(bytes);
  }

  return {
    errors: [
      'unsupported frame code 0x' + frameCode.toString(16) +
        ' (only the 0x6d periodic, 0x6e alarm and 0x30 daily frames are normalized)'
    ]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "breath";
  }
  return result;
}
