// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for IoT Factory Metering Node (generic input
// bridge: 4-20 mA, analog voltage, digital input, pulse counter).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/iot-factory/generic-decoder.js,
// attributed in NOTICE). Upstream emits a `frames` array with per-frame ISO
// timestamps (non-deterministic new Date()); this module normalizes the FIRST
// input measurement frame to the shared vocabulary and does NOT copy upstream.
//
// Payload (fPort 10): a power byte then a protocol byte precede the frames.
//   byte0 power: bit0 = power type (0 battery / 1 external); bits1..7 = battery
//                charge percent.
//   byte1 protocol: bit0 = serial-number present; bit4 = payload-size present.
// If the SN flag is set a 4-byte SN follows; if the payload-size flag is set a
// 2-byte size follows. Then one or more frames, each starting with a 16-bit
// little-endian header (low 12 bits = frame type, high 4 bits = reason).
//
// Frame types normalized here (first matching frame wins):
//   0x0D pulse counter: u32le time, u8 pin, u32le counter -> pulse.total
//   0x0A 4-20 mA:       u8 pin, u32le time, u32le mA      -> analog.current (mA)
//   0x0C analog input:  u32le time, u8 pin, u32le mV      -> analog.voltage (V, mV/1000)
//   0x0B digital input: u32le time, u8 pin, u8 state      -> action.contactState
// The battery charge percent from the header is emitted as `batteryPercent`
// (vocabulary `battery` is volts). Frames also carry a `time` (RFC3339 UTC).

function u32le(bytes, off) {
  return (bytes[off]) + (bytes[off + 1] * 256) + (bytes[off + 2] * 65536) + (bytes[off + 3] * 16777216);
}

function u16le(bytes, off) {
  return bytes[off] + (bytes[off + 1] * 256);
}

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function rfc3339(epochSeconds) {
  var secsOfDay = epochSeconds % 86400;
  var days = (epochSeconds - secsOfDay) / 86400;
  var hh = Math.floor(secsOfDay / 3600);
  var mm = Math.floor((secsOfDay % 3600) / 60);
  var ss = secsOfDay % 60;
  var year = 1970;
  while (true) {
    var leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    var yearDays = leap ? 366 : 365;
    if (days < yearDays) { break; }
    days -= yearDays;
    year++;
  }
  var isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  var monthLengths = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var month = 0;
  while (days >= monthLengths[month]) {
    days -= monthLengths[month];
    month++;
  }
  return year + '-' + pad2(month + 1) + '-' + pad2(days + 1) + 'T' +
    pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss) + 'Z';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 10)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short for a Metering Node frame'] };
  }

  var batteryPercent = (bytes[0] & 0xfe) >> 1;
  var proto = bytes[1];
  var off = 2;
  if (proto & 0x01) { off += 4; } // serial number
  if (proto & 0x10) { off += 2; } // payload size

  if (off + 2 > bytes.length) {
    return { errors: ['no frame present after header'] };
  }
  var frameHeader = u16le(bytes, off);
  var type = frameHeader & 0x0fff;
  off += 2;

  var data = { batteryPercent: batteryPercent };

  if (type === 0x0d) {
    if (off + 9 > bytes.length) { return { errors: ['truncated pulse-counter frame'] }; }
    data.time = rfc3339(u32le(bytes, off));
    data.pulse = { total: u32le(bytes, off + 5) };
    return { data: data };
  }
  if (type === 0x0a) {
    if (off + 9 > bytes.length) { return { errors: ['truncated 4-20 mA frame'] }; }
    data.time = rfc3339(u32le(bytes, off + 1));
    data.analog = { current: u32le(bytes, off + 5) };
    return { data: data };
  }
  if (type === 0x0c) {
    if (off + 9 > bytes.length) { return { errors: ['truncated analog-input frame'] }; }
    data.time = rfc3339(u32le(bytes, off));
    data.analog = { voltage: round(u32le(bytes, off + 5) / 1000, 3) };
    return { data: data };
  }
  if (type === 0x0b) {
    if (off + 6 > bytes.length) { return { errors: ['truncated digital-input frame'] }; }
    data.time = rfc3339(u32le(bytes, off));
    data.action = { contactState: (bytes[off + 5] & 0x01) ? 'closed' : 'open' };
    return { data: data };
  }

  return { errors: ['frame type 0x' + type.toString(16) + ' is not an input measurement'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "iot-factory", model: "metering-node" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "iot-factory";
    result.data.model = "metering-node";
  }
  return result;
}
