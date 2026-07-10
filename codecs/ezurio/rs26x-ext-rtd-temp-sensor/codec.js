// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ezurio/rs26x-ext-rtd-temp-sensor (Sentrius RS26x
// with an external RTD probe). Reports temperature in degrees Celsius over
// LoRaWAN.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/ezurio/rs26x.js, attributed in NOTICE).
// Normalization authored here; the upstream Decode output is NOT copied.
//
// The RS26x uses a tag-length-value uplink. Sensor-data frames start with
// message-type byte 0x00:
//   bytes[0]   uplink message type (0x00 = sensor data, 0x01 = sensor config)
//   bytes[1]   status: bits 7..6 = battery status enum, bits 5..0 = device-status
//              bitfield (sensor fault, bandwidth limitation, backlogs available,
//              backlog wraparound, unsupported API version)
//   bytes[2..] TLV elements. The current reading is the first element.
//
// The external RTD probe supports the wider temperature range and emits the
// wide-width temperature element (tag 0x03): four bytes, int32BE / 65536 ->
// degrees Celsius (Q16.16 fixed point).
//
// Battery: the header exposes only a coarse 4-level battery STATUS enum
// (Critical/Replace/OK/Good), not a voltage and not a numeric percentage, so the
// vocabulary `battery` (volts) key is not emitted; the enum is surfaced as the
// string extra `batteryStatus`. Config frames (0x01) and history-only frames
// (wide backlog tag 0x04, wide aggregate tag 0x05) carry no current reading and
// are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s32(b0, b1, b2, b3) {
  var v = ((b0 & 0xff) * 16777216) + ((b1 & 0xff) << 16) + ((b2 & 0xff) << 8) + (b3 & 0xff);
  return v >= 2147483648 ? v - 4294967296 : v;
}

function batteryStatusName(v) {
  if (v === 0) { return 'Critical'; }
  if (v === 1) { return 'Replace'; }
  if (v === 2) { return 'OK'; }
  if (v === 3) { return 'Good'; }
  return 'unknown';
}

function deviceStatusFlags(status6) {
  return {
    sensorFault: Boolean(status6 & 0x01),
    bandwidthLimitation: Boolean(status6 & 0x02),
    backlogsAvailable: Boolean(status6 & 0x04),
    backlogWraparound: Boolean(status6 & 0x08),
    unsupportedApiVersion: Boolean(status6 & 0x10)
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return { errors: ['missing or short payload'] };
  }
  if (bytes[0] === 0x01) {
    return { errors: ['sensor-configuration frame (0x01) carries no temperature measurement'] };
  }
  if (bytes[0] !== 0x00) {
    return { errors: ['unsupported uplink message type 0x' + bytes[0].toString(16)] };
  }

  var status = bytes[1];
  var tag = bytes[2];

  // Wide-width current temperature element (tag 0x03): int32BE / 65536.
  if (tag === 0x03) {
    if (bytes.length < 7) {
      return { errors: ['truncated wide temperature element'] };
    }
    var data = {};
    data.temperature = round(s32(bytes[3], bytes[4], bytes[5], bytes[6]) / 65536, 2);
    data.batteryStatus = batteryStatusName(status >> 6);
    data.deviceStatus = deviceStatusFlags(status & 0x3f);
    return { data: data };
  }

  if (tag === 0x04) {
    return { errors: ['wide backlog-only frame (tag 0x04) carries no current reading'] };
  }
  if (tag === 0x05) {
    return { errors: ['wide aggregate-only frame (tag 0x05) carries no single current reading'] };
  }
  return { errors: ['unexpected leading element tag 0x' + tag.toString(16) + ' (expected wide temperature 0x03)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "ezurio";
    result.data.model = "rs26x-ext-rtd-temp-sensor";
  }
  return result;
}
