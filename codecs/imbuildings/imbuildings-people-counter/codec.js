// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the IMBuildings People Counter: an overhead
// bidirectional pedestrian counter that reports per-interval directional counts
// (counter_a / counter_b), running cumulative totals, battery voltage, and
// device/sensor status.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/imbuildings/imbuildings.js, attributed
// in NOTICE). This module re-authors the JSON to the normalized vocabulary and
// never copies the upstream output.
//
// Frame detection follows upstream: a people-counter payload either carries the
// IMBuildings header (byte[0]=0x02 payload type, byte[1]=variant, bytes[2..9]
// device id) or is a headerless payload identified purely by FPort (26 -> v6,
// 27 -> v7, 28 -> v8). All field offsets are measured from the END of the frame,
// so the same parser serves both header and headerless layouts.
//
// Variant 6 (rich data frame) field mapping (offsets from end):
//   device_status   (len-13)                 -> deviceStatus (extra)
//   battery_voltage (len-12..-11) / 100       -> battery (centivolts -> V)
//   counter_a       (len-10..-9)              -> people.in  (entries this interval)
//   counter_b       (len-8..-7)               -> people.out (exits this interval)
//   sensor_status   (len-6)                   -> sensorStatus (extra)
//   total_counter_a (len-5..-4)               -> totalCounterA (cumulative extra)
//   total_counter_b (len-3..-2)               -> totalCounterB (cumulative extra)
//   payload_counter (len-1)                   -> payloadCounter (extra)
//   people.total = total_counter_a - total_counter_b  (cumulative net)
//
// Variant 7 (totals-only frame): total_counter_a/b -> totals + people.total.
// Variant 8 (heartbeat): device_status + battery + sensor_status (no counts).

var PAYLOAD_PEOPLE_COUNTER = 0x02;

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, index) {
  return (bytes[index] << 8) + bytes[index + 1];
}

function detectVariant(input) {
  var bytes = input.bytes;
  // Header-prefixed frames.
  if (bytes[0] === PAYLOAD_PEOPLE_COUNTER && bytes[1] === 0x06 && bytes.length === 23) return 6;
  if (bytes[0] === PAYLOAD_PEOPLE_COUNTER && bytes[1] === 0x07 && bytes.length === 15) return 7;
  if (bytes[0] === PAYLOAD_PEOPLE_COUNTER && bytes[1] === 0x08 && bytes.length === 14) return 8;
  // Headerless frames identified by FPort.
  if (input.fPort === 26 && bytes.length === 13) return 6;
  if (input.fPort === 27 && bytes.length === 5) return 7;
  if (input.fPort === 28 && bytes.length === 4) return 8;
  return 0;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['missing payload bytes'] };
  }

  var variant = detectVariant(input);
  if (!variant) {
    return { errors: ['unrecognized people-counter frame (unknown variant / length / fPort)'] };
  }

  var n = bytes.length;
  var data = {};

  if (variant === 6) {
    var counterA = u16be(bytes, n - 10);
    var counterB = u16be(bytes, n - 8);
    var totalA = u16be(bytes, n - 5);
    var totalB = u16be(bytes, n - 3);
    data.people = { in: counterA, out: counterB, total: totalA - totalB };
    data.battery = round(u16be(bytes, n - 12) / 100, 2);
    data.deviceStatus = bytes[n - 13];
    data.sensorStatus = bytes[n - 6];
    data.totalCounterA = totalA;
    data.totalCounterB = totalB;
    data.payloadCounter = bytes[n - 1];
    return { data: data };
  }

  if (variant === 7) {
    var t7a = u16be(bytes, n - 4);
    var t7b = u16be(bytes, n - 2);
    data.people = { total: t7a - t7b };
    data.sensorStatus = bytes[n - 5];
    data.totalCounterA = t7a;
    data.totalCounterB = t7b;
    return { data: data };
  }

  // variant === 8 (heartbeat: status + battery only, no counts)
  return {
    errors: ['heartbeat frame (variant 8) carries no people count'],
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "imbuildings";
    result.data.model = "imbuildings-people-counter";
  }
  return result;
}
