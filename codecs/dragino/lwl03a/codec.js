// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LWL03A (Water Leak Sensor), real-time
// leak-status uplink (fPort 2).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lwl03a.js, attributed in
// NOTICE). The device's RTC timestamp is emitted as the vocabulary `time`
// (RFC3339); leak counters are device-specific camelCase extras. The datalog
// (fPort 3), config (fPort 4), and status (fPort 5) frames are out of scope
// for this codec.

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length < 11) {
    return { errors: ['expected at least 11 bytes, got ' + bytes.length] };
  }

  var data = {};

  data.water = { leak: (bytes[0] & 0x01) === 0x01 };
  data.alarm = (bytes[0] & 0x02) === 0x02;
  data.leakEvents = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  data.lastLeakDuration = (bytes[4] << 16) | (bytes[5] << 8) | bytes[6];

  // Bytes 7-10: device RTC time of the reading (unix seconds). Emitted only
  // when set (a zero timestamp means the device clock is unconfigured).
  var epoch = ((bytes[7] << 24) | (bytes[8] << 16) | (bytes[9] << 8) | bytes[10]) >>> 0;
  if (epoch > 0) {
    data.time = new Date(epoch * 1000).toISOString();
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lwl03a";
  }
  return result;
}
