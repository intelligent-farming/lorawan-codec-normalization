// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for radio-bridge/rbs306-420ma (RadioBridge RBS306
// 4-20 mA Current Loop Sensor). Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 RadioBridge packet
// decoder (TheThingsNetwork/lorawan-devices vendor/radio-bridge/
// radio_bridge_packet_decoder.js, attributed in NOTICE). Upstream emits a nested
// bag { Protocol, Counter, Type, A420mA: { Event, Current } }; this module reads
// the same 4-20 mA analog event and authors normalized vocabulary keys.
// Upstream normalization is never copied.
//
// Packet header (all RadioBridge uplinks):
//   byte[0] high nibble = protocol version, low nibble = packet counter
//   byte[1]            = payload/event type (0x11 = 4-20 mA analog event)
// 4-20 mA analog event (byte[1] == 0x11):
//   byte[2]           = event sub-type (0 periodic, 1 above-upper, 2 below-lower,
//                       3 rise-on-change, 4 fall-on-change)
//   bytes[3..4]       = current in units of 10 uA, big-endian -> mA (raw / 100)
//
// Mapping into the normalized vocabulary:
//   current           -> analog.current (mA)
//   event sub-type    -> analogEvent (string extra)
//   packet counter    -> packetCounter (number extra)
// Non-analog RadioBridge events (reset, supervisory, tamper, ...) carry no
// current-loop measurement and return an error.

var SENSOR420MA_EVENT = 0x11;

var EVENT_LABEL = {
  0: 'periodicReport',
  1: 'aboveUpperThreshold',
  2: 'belowLowerThreshold',
  3: 'reportOnChangeIncrease',
  4: 'reportOnChangeDecrease'
};

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 2) {
    return { errors: ['empty or truncated payload'] };
  }

  var payloadType = b[1];
  if (payloadType !== SENSOR420MA_EVENT) {
    return {
      errors: ['event type 0x' + payloadType.toString(16) +
        ' is not a 4-20 mA analog event (0x11)']
    };
  }
  if (b.length < 5) {
    return { errors: ['truncated 4-20 mA analog event'] };
  }

  var eventType = b[2];
  var mA = round(((b[3] << 8) | b[4]) / 100, 2);

  var data = {
    analog: { current: mA },
    analogEvent: EVENT_LABEL[eventType] !== undefined ? EVENT_LABEL[eventType] : 'undefined',
    packetCounter: b[0] & 0x0f
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "radio-bridge";
    result.data.model = "rbs306-420ma";
  }
  return result;
}
